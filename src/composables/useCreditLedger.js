// UNIT_TYPE=Hook

/**
 * useCreditLedger composable
 *
 * Manages the user's credit ledger stored at {podRoot}/apps/TomTwin/thebrain-credits.json.
 *
 * Read path:
 *   loadCredits(podRoot, bearerToken) — GETs the ledger JSON from the pod.
 *   Returns { balance: 0, ledger: [], processedEvents: [], updatedAt: null,
 *             trialUsed: false, trialStartedAt: null } on 404.
 *   Uses ur.hyperFetch for the authenticated request (window.solid.session bearer).
 *
 * Purchase path:
 *   startCheckout(priceId) — POSTs to /api/stripe-checkout with { priceId, podRoot, returnUrl }
 *   and the user's bearer token. Redirects to the returned Stripe Checkout URL.
 *
 * Reactive state:
 *   balance        — Ref<number>       current credit balance (updated after load)
 *   trialUsed      — Ref<boolean>      true once the free trial has been consumed
 *   trialStartedAt — Ref<string|null>  ISO timestamp when trial began, null until then
 *   ledger         — Ref<array>        full ledger entry list
 *   loading        — Ref<boolean>      true while fetching
 *   error          — Ref<string|null>  error message on failure
 *
 * @returns {{
 *   balance:        import('vue').Ref<number>,
 *   trialUsed:      import('vue').Ref<boolean>,
 *   trialStartedAt: import('vue').Ref<string|null>,
 *   ledger:         import('vue').Ref<array>,
 *   loading:        import('vue').Ref<boolean>,
 *   error:          import('vue').Ref<string|null>,
 *   loadCredits:    (podRoot: string, bearerToken: string) => Promise<void>,
 *   startCheckout:  (priceId: string) => Promise<void>
 * }}
 *
 * Preconditions:
 *   - window.solid.session must be set to the authenticated session before calling loadCredits().
 *   - podRoot must be a non-empty string (no trailing slash).
 *   - bearerToken is the user's current Solid OIDC access token (for the checkout KV store).
 *
 * Errors:
 *   - error.value is null on success or 404.
 *   - error.value is a string on any unexpected failure.
 *
 * Spec: 3P.F.ContributionFlow — startCheckout initiates the Stripe Checkout purchase flow
 *       3P.V.ContributionEventCompletionRate — loadCredits verifies completed purchases
 *       Evo3a.TrialSchemaAndGate — trialUsed and trialStartedAt fields tracked here
 */

import { ref } from 'vue'
import { ur } from '@kaigilb/twinpod-client'

/**
 * Ensure a Solid LDP container exists at containerUrl.
 * Issues a HEAD to check; if absent (404), creates it via PUT with Link type header.
 * No-op if already exists.
 *
 * @param {string} containerUrl - URL ending with /
 * @param {Function} authenticatedFetch - session.fetch from caller
 */
async function ensureContainer(containerUrl, authenticatedFetch) {
  try {
    const check = await authenticatedFetch(containerUrl, { method: 'HEAD' })
    if (check.ok || check.status === 200) return // already exists
    if (check.status !== 404) return // unexpected — don't attempt to create
    // Create the container
    await authenticatedFetch(containerUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': 'text/turtle',
        'Link': '<http://www.w3.org/ns/ldp#BasicContainer>; rel="type"'
      },
      body: ''
    })
  } catch (e) {
    console.warn('[useCreditLedger] ensureContainer failed for', containerUrl, e)
  }
}

// Module-level reactive state — one instance per app (matches usePodWorkbook pattern)
const balance = ref(0)
// Spec: Evo3a.TrialSchemaAndGate — trial fields tracked reactively so App.vue
// can show SessionCostGate immediately on load when balance=0 and trialUsed=true.
// Null-safe: missing fields in existing ledgers treated as false/null.
const trialUsed = ref(false)
const trialStartedAt = ref(null)
const ledger = ref([])
const loading = ref(false)
const error = ref(null)

// Captured on loadCredits() call; reused by startCheckout() so it doesn't need a parameter
let _podRoot = ''
let _bearerToken = ''

export function useCreditLedger() {

  /**
   * Loads the credit ledger from the pod.
   * Sets balance and ledger reactively. 404 is treated as empty ledger (first-time user).
   *
   * @param {string} podRoot - Pod root URL without trailing slash.
   * @param {string} bearerToken - User's current Solid OIDC access token.
   * @param {Function} [authenticatedFetch] - DPoP-authenticated session.fetch. Falls back
   *   to ur.hyperFetch if not provided (legacy path — may return Turtle for JSON resources).
   *
   * Spec: 3P.F.ContributionFlow — credits displayed after purchase round-trip completes
   */
  async function loadCredits(podRoot, bearerToken, authenticatedFetch) {
    if (!podRoot) return

    _podRoot = podRoot
    _bearerToken = bearerToken || ''

    loading.value = true
    error.value = null

    const ledgerUrl = podRoot + '/apps/TomTwin/thebrain-credits.json'

    try {
      // Use session.fetch (DPoP) when available — ur.hyperFetch adds RDF Accept headers
      // which cause the pod to return Turtle instead of JSON for .json resources.
      const fetcher = authenticatedFetch || ur.hyperFetch
      const response = await fetcher(ledgerUrl, {
        method: 'GET',
        headers: { 'Accept': 'application/json' }
      })

      if (response.ok) {
        const data = await response.json()
        balance.value = data.balance ?? 0
        ledger.value = data.ledger ?? []
        // Spec: Evo3a.TrialSchemaAndGate — null-safe: missing fields on existing
        // ledgers treated as false/null so existing users are not affected.
        trialUsed.value = data.trialUsed ?? false
        trialStartedAt.value = data.trialStartedAt ?? null
      } else if (response.status === 404) {
        // First-time user — no ledger yet; use defaults
        balance.value = 0
        ledger.value = []
        trialUsed.value = false
        trialStartedAt.value = null
      } else {
        console.error('[useCreditLedger] Unexpected status loading ledger:', response.status)
        error.value = `Could not load credit balance (${response.status})`
      }
    } catch (err) {
      console.error('[useCreditLedger] Network error loading ledger:', err)
      error.value = 'Could not load credit balance'
    } finally {
      loading.value = false
    }
  }

  /**
   * Initiates a Stripe Checkout session for the given price bundle.
   * Calls /api/stripe-checkout with the priceId, podRoot, returnUrl, and the user's
   * bearer token (stored in KV by the checkout endpoint for the webhook to use later).
   * Redirects the browser to the Stripe-hosted Checkout page on success.
   *
   * @param {string} priceId - Stripe Price ID for the bundle to purchase.
   *
   * Spec: 3P.F.ContributionFlow — opens Stripe Checkout for a credit bundle purchase
   */
  async function startCheckout(priceId) {
    if (!priceId || !_podRoot) {
      console.error('[useCreditLedger] startCheckout requires priceId and podRoot to be set')
      return
    }

    loading.value = true
    error.value = null

    try {
      const response = await fetch('/api/stripe-checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          priceId,
          podRoot: _podRoot,
          returnUrl: window.location.href,
          // Pass the bearer token so the checkout endpoint can store it in KV
          // for the webhook handler to use when writing the credit ledger.
          bearerToken: _bearerToken
        })
      })

      if (!response.ok) {
        const body = await response.json().catch(() => ({}))
        console.error('[useCreditLedger] Checkout API error:', body)
        error.value = 'Could not start checkout. Please try again.'
        return
      }

      const { url } = await response.json()
      if (!url) {
        error.value = 'No checkout URL returned. Please try again.'
        return
      }

      // Redirect to Stripe-hosted Checkout
      window.location.href = url
    } catch (err) {
      console.error('[useCreditLedger] Network error starting checkout:', err)
      error.value = 'Could not reach checkout. Please try again.'
    } finally {
      // Note: loading stays true through the redirect; no need to reset in the success path
      loading.value = false
    }
  }

  /**
   * Check the KV pending-credit queue and apply any unprocessed entries to the pod ledger.
   * Called on every page load after auth — replaces the URL-param finalization approach.
   *
   * Flow:
   *   1. GET /api/credits-pending?podRoot=... — returns [{sessionId, credits, ts}].
   *   2. If none, return immediately (fast path — most loads have no pending credits).
   *   3. GET current ledger from pod using authenticatedFetch.
   *   4. For each pending entry not already in processedEvents: append it to the ledger.
   *   5. PUT updated ledger to pod using authenticatedFetch (Solid DPoP session).
   *   6. DELETE /api/credits-confirm to remove applied entries from the KV queue.
   *
   * @param {Function} authenticatedFetch - session.fetch from App.vue (DPoP-authenticated).
   *
   * Spec: 3P.F.ContributionFlow — completes the purchase round-trip on the next authenticated load
   */
  async function applyPendingCredits(authenticatedFetch) {
    if (!_podRoot || !authenticatedFetch) return

    loading.value = true
    error.value = null

    try {
      // Step 1 — check for pending credits in KV
      const pendingRes = await fetch(`/api/credits-pending?podRoot=${encodeURIComponent(_podRoot)}`)
      if (!pendingRes.ok) {
        console.warn('[useCreditLedger] credits-pending check failed:', pendingRes.status)
        return
      }
      const { pending } = await pendingRes.json()
      if (!pending || pending.length === 0) return  // fast path — nothing to apply

      console.log('[useCreditLedger] Pending credits found:', pending)

      // Step 2 — read current ledger from pod
      const ledgerUrl = _podRoot + '/apps/TomTwin/thebrain-credits.json'
      // Spec: Evo3a.TrialSchemaAndGate — preserve trialUsed and trialStartedAt
      // when round-tripping the ledger through applyPendingCredits.
      let currentLedger = {
        balance: 0, ledger: [], processedEvents: [], updatedAt: null,
        trialUsed: false, trialStartedAt: null
      }
      try {
        const getRes = await authenticatedFetch(ledgerUrl, {
          method: 'GET',
          headers: { 'Accept': 'application/json' }
        })
        if (getRes.ok) {
          const existing = await getRes.json()
          currentLedger = {
            balance: existing.balance ?? 0,
            ledger: existing.ledger ?? [],
            processedEvents: existing.processedEvents ?? [],
            updatedAt: existing.updatedAt ?? null,
            // Null-safe: missing fields on existing ledgers default to false/null
            trialUsed: existing.trialUsed ?? false,
            trialStartedAt: existing.trialStartedAt ?? null
          }
        }
        // 404 = no ledger yet — use empty (user's first purchase)
      } catch (e) {
        console.warn('[useCreditLedger] GET ledger error (using empty):', e)
      }

      // Step 3 — apply each pending entry not already in processedEvents
      const now = new Date().toISOString()
      const appliedSessionIds = []
      let didUpdate = false

      for (const entry of pending) {
        // Always mark for confirmation cleanup (even if already processed)
        appliedSessionIds.push(entry.sessionId)

        if (currentLedger.processedEvents.includes(entry.sessionId)) {
          // Already in ledger — sync balance but don't re-credit
          continue
        }

        currentLedger.balance = (currentLedger.balance || 0) + entry.credits
        currentLedger.ledger.push({
          type: 'purchase',
          credits: entry.credits,
          stripeSessionId: entry.sessionId,
          ts: entry.ts || now
        })
        currentLedger.processedEvents.push(entry.sessionId)
        currentLedger.updatedAt = now
        didUpdate = true
      }

      if (didUpdate) {
        // Ensure parent containers exist before writing
        await ensureContainer(_podRoot + '/apps/', authenticatedFetch)
        await ensureContainer(_podRoot + '/apps/TomTwin/', authenticatedFetch)

        // Write updated ledger to pod using DPoP-authenticated session.fetch
        const putRes = await authenticatedFetch(ledgerUrl, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(currentLedger, null, 2)
        })

        if (!putRes.ok) {
          const body = await putRes.text().catch(() => '')
          console.error('[useCreditLedger] PUT ledger failed:', putRes.status, body)
          error.value = `Could not save credit balance (${putRes.status})`
          return
        }

        console.log('[useCreditLedger] Pending credits applied — new balance:', currentLedger.balance)
      }

      // Always update reactive state to reflect current ledger
      balance.value = currentLedger.balance
      ledger.value = currentLedger.ledger
      // Spec: Evo3a.TrialSchemaAndGate — keep trial state reactive after credit apply
      trialUsed.value = currentLedger.trialUsed ?? false
      trialStartedAt.value = currentLedger.trialStartedAt ?? null

      // Step 4 — confirm applied entries so KV queue is cleaned up
      if (appliedSessionIds.length > 0) {
        try {
          await fetch('/api/credits-confirm', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ podRoot: _podRoot, appliedSessionIds })
          })
        } catch (e) {
          // Non-fatal — the entry will expire from KV after 24h anyway
          console.warn('[useCreditLedger] credits-confirm failed (non-fatal):', e)
        }
      }

    } catch (err) {
      console.error('[useCreditLedger] applyPendingCredits error:', err)
      error.value = 'Could not apply pending credits'
    } finally {
      loading.value = false
    }
  }

  /**
   * Writes trial-start state to the pod ledger via DPoP-authenticated session.fetch.
   *
   * Called by App.vue when the Worker emits a trial_start SSE event.
   * The Worker cannot make this write (DPoP required), so the frontend does it.
   *
   * Sets trialUsed=true and trialStartedAt on the existing ledger.
   * Updates the module-level reactive refs immediately so the UI reflects
   * the trial state without waiting for a full loadCredits() reload.
   *
   * Non-fatal on failure — the trial has already started (KV is updated).
   *
   * @param {Function} authenticatedFetch - session.fetch (DPoP-authenticated).
   * @param {string} ts - ISO timestamp string returned in the trial_start SSE event.
   *
   * Spec: Evo3b.TrialTimerAndTermination — pod write-back when trial first starts
   */
  async function writeTrialStart(authenticatedFetch, ts) {
    if (!_podRoot || !authenticatedFetch || !ts) {
      console.warn('[useCreditLedger] writeTrialStart: missing podRoot, authenticatedFetch, or ts')
      return
    }

    // Update reactive state immediately (optimistic)
    trialUsed.value = true
    trialStartedAt.value = ts

    const ledgerUrl = _podRoot + '/apps/TomTwin/thebrain-credits.json'
    try {
      // Read current ledger to avoid losing other fields
      let existing = {
        balance: balance.value,
        ledger: ledger.value,
        processedEvents: [],
        updatedAt: null,
        trialUsed: false,
        trialStartedAt: null
      }
      try {
        const getRes = await authenticatedFetch(ledgerUrl, {
          method: 'GET',
          headers: { 'Accept': 'application/json' }
        })
        if (getRes.ok) {
          const data = await getRes.json()
          existing = { ...existing, ...data }
        }
      } catch (e) {
        console.warn('[useCreditLedger] writeTrialStart GET failed (using in-memory state):', e)
      }

      // Ensure parent containers exist
      await ensureContainer(_podRoot + '/apps/', authenticatedFetch)
      await ensureContainer(_podRoot + '/apps/TomTwin/', authenticatedFetch)

      const updated = { ...existing, trialUsed: true, trialStartedAt: ts, updatedAt: new Date().toISOString() }
      const putRes = await authenticatedFetch(ledgerUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updated, null, 2)
      })
      if (!putRes.ok) {
        console.warn('[useCreditLedger] writeTrialStart PUT failed (non-fatal):', putRes.status)
      }
    } catch (err) {
      // Non-fatal — trial is active in KV; pod write is best-effort
      console.warn('[useCreditLedger] writeTrialStart error (non-fatal):', err.message)
    }
  }

  /**
   * Decrements the credit balance by `amount` after a successful response.
   *
   * Optimistic update: `balance.value -= amount` immediately so the UI reflects
   * the change before the pod write completes.
   *
   * Async write: reads the current pod ledger, applies the debit, PUTs the updated
   * ledger back using DPoP-authenticated session.fetch. Non-fatal on failure —
   * the optimistic decrement is already applied and the Worker gate will fire
   * naturally when balance reaches 0 on the next message.
   *
   * Guard: if balance is already 0 or amount is 0, this is a no-op.
   *
   * @param {number} amount - Credits to deduct (must be > 0).
   * @param {Function} authenticatedFetch - session.fetch (DPoP-authenticated).
   *
   * Spec: Evo4.CreditDecrementPerToken — pod write-back for each consumed response
   */
  async function decrementCredit(amount, authenticatedFetch) {
    if (!amount || amount <= 0 || !_podRoot || !authenticatedFetch) return
    if (balance.value <= 0) return  // already exhausted — no-op

    // Optimistic update — UI reflects immediately (before pod write)
    balance.value = Math.max(0, balance.value - amount)

    const ledgerUrl = _podRoot + '/apps/TomTwin/thebrain-credits.json'
    try {
      // Read current ledger to avoid losing other fields
      let existing = {
        balance: balance.value,
        ledger: ledger.value,
        processedEvents: [],
        updatedAt: null,
        trialUsed: trialUsed.value,
        trialStartedAt: trialStartedAt.value
      }
      try {
        const getRes = await authenticatedFetch(ledgerUrl, {
          method: 'GET',
          headers: { 'Accept': 'application/json' }
        })
        if (getRes.ok) {
          const data = await getRes.json()
          existing = { ...existing, ...data }
        }
      } catch (e) {
        console.warn('[useCreditLedger] decrementCredit GET failed (using in-memory state):', e)
      }

      // Apply debit to the freshly-read balance (guards against concurrent updates)
      const newBalance = Math.max(0, (existing.balance ?? 0) - amount)

      // Sync reactive state to the server-confirmed balance
      balance.value = newBalance

      const updated = {
        ...existing,
        balance: newBalance,
        updatedAt: new Date().toISOString()
      }

      const putRes = await authenticatedFetch(ledgerUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updated, null, 2)
      })
      if (!putRes.ok) {
        console.warn('[useCreditLedger] decrementCredit PUT failed (non-fatal):', putRes.status)
      }
    } catch (err) {
      // Non-fatal — optimistic decrement already applied; pod write is best-effort
      console.warn('[useCreditLedger] decrementCredit error (non-fatal):', err.message)
    }
  }

  return {
    balance,
    trialUsed,
    trialStartedAt,
    ledger,
    loading,
    error,
    loadCredits,
    startCheckout,
    applyPendingCredits,
    writeTrialStart,
    decrementCredit
  }
}
