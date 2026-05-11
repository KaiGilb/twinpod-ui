// UNIT_TYPE=Hook

/**
 * useCreditLedger composable
 *
 * Manages the user's credit ledger stored at {podRoot}/apps/TomTwin/thebrain-credits.json.
 *
 * Read path:
 *   loadCredits(podRoot, bearerToken, authenticatedFetch, webId) — GETs the ledger JSON
 *   from the pod. Returns { balance: 0, ledger: [], processedEvents: [], updatedAt: null,
 *   trialUsed: false, trialStartedAt: null } on 404 (unless webId is whitelisted —
 *   whitelisted users get a 100K grant written to the pod on first login).
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
 *   loadCredits:    (podRoot: string, bearerToken: string, authenticatedFetch?: Function, webId?: string) => Promise<void>,
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
 *       Evo9.WebIDFreeCredit — whitelisted WebIDs receive a 100K credit grant on first login
 */

import { ref } from 'vue'
import { ur } from '@kaigilb/twinpod-client'
import { isRealTwinPodResource } from './util/twinpod-resource-exists.js'

// Spec: Evo9.WebIDFreeCredit — whitelisted WebIDs receive a one-time 100K credit grant
// on first login (no existing pod ledger). They appear as normal credit holders to the
// gate, meter, and telemetry — usage is tracked, not bypassed.
// Cycle 19 follow-up #5 (2026-04-28): added tst-heppa and tst-testertom to unblock
// fresh-pod testing of the whitelist branch.
// 2026-05-10 (BestSavedProjectFileFormat sub-cycle): added tst-planner for typed-JSON
// session-format browser testing on the no-books branch.
const FREE_CREDIT_WEBIDS = [
  'https://kai.gilb.com/i',
  'https://tommy.gilb.com/i',
  'https://tst-heppa.demo.systemtwin.com/i',
  'https://tst-testertom.demo.systemtwin.com/i',
  'https://tst-planner.demo.systemtwin.com/i'
]
const FREE_CREDIT_AMOUNT = 100000

/**
 * Ensure a Solid LDP container exists at containerUrl.
 * Issues a HEAD to check; if absent (404), creates it via PUT with Link type header.
 * No-op if already exists.
 *
 * Cycle 19 follow-up #9 (2026-04-27): added optional { slug, label } options so
 * containers created on TwinPod display with a human-readable name in the
 * SystemTwin™ app tree. Without these, an empty-Turtle PUT lands as a generic
 * BasicContainer that the SystemTwin™ app labels with a derived dotted-prefix
 * name (e.g. `_TomTwin.apps_`). With Slug + rdfs:label the app shows the proper
 * name (e.g. "TomTwin" / "The Brain (Tom Twin) — App Data"). See
 * Reference_Code_TwinPod-DefaultContainers.md § Companion quirk.
 *
 * @param {string} containerUrl - URL ending with /
 * @param {Function} authenticatedFetch - session.fetch from caller
 * @param {Object} [opts]
 * @param {string} [opts.slug] - Slug header (display name hint for SystemTwin™ tree)
 * @param {string} [opts.label] - rdfs:label literal written into the container's Turtle body
 */
async function ensureContainer(containerUrl, authenticatedFetch, opts = {}) {
  try {
    const check = await authenticatedFetch(containerUrl, { method: 'HEAD' })
    if (check.ok || check.status === 200) return // already exists
    if (check.status !== 404) return // unexpected — don't attempt to create
    // Create the container
    const headers = {
      'Content-Type': 'text/turtle',
      'Link': '<http://www.w3.org/ns/ldp#BasicContainer>; rel="type"'
    }
    if (opts.slug) headers['Slug'] = opts.slug
    const body = opts.label
      ? `@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .\n<> rdfs:label "${opts.label.replace(/"/g, '\\"')}" .`
      : ''
    await authenticatedFetch(containerUrl, {
      method: 'PUT',
      headers,
      body
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
const loading = ref(false)           // true during loadCredits / applyPendingCredits
const checkoutLoading = ref(false)   // true during startCheckout only — separate so the
                                     // BuyCreditsButton buttons are NOT disabled while
                                     // loadCredits is in-flight (page-reload paygate bug)
const error = ref(null)

// Captured on loadCredits() call; reused by startCheckout() so it doesn't need a parameter
let _podRoot = ''
let _bearerToken = ''

export function useCreditLedger() {

  /**
   * Loads the credit ledger from the pod.
   * Sets balance and ledger reactively. 404 is treated as empty ledger (first-time user),
   * unless webId is in FREE_CREDIT_WEBIDS — in that case the ledger is seeded with
   * FREE_CREDIT_AMOUNT credits and written to the pod immediately.
   *
   * @param {string} podRoot - Pod root URL without trailing slash.
   * @param {string} bearerToken - User's current Solid OIDC access token.
   * @param {Function} [authenticatedFetch] - DPoP-authenticated session.fetch. Falls back
   *   to ur.hyperFetch if not provided (legacy path — may return Turtle for JSON resources).
   * @param {string} [webId] - The authenticated user's WebID. Used to match FREE_CREDIT_WEBIDS.
   *
   * Spec: 3P.F.ContributionFlow — credits displayed after purchase round-trip completes
   *       Evo9.WebIDFreeCredit — whitelisted WebIDs receive a 100K grant on first login
   */
  async function loadCredits(podRoot, bearerToken, authenticatedFetch, webId) {
    if (!podRoot) return

    _podRoot = podRoot
    _bearerToken = bearerToken || ''

    loading.value = true
    error.value = null

    // Cycle 19 follow-up #5: diagnostic logging — entry point.
    console.info('[useCreditLedger] loadCredits start — webId:', webId || '(none)', 'podRoot:', podRoot)

    const ledgerUrl = podRoot + '/apps/TomTwin/thebrain-credits.json'

    try {
      // Use session.fetch (DPoP) when available — ur.hyperFetch adds RDF Accept headers
      // which cause the pod to return Turtle instead of JSON for .json resources.
      const fetcher = authenticatedFetch || ur.hyperFetch
      const response = await fetcher(ledgerUrl, {
        method: 'GET',
        headers: { 'Accept': 'application/json' }
      })

      // Cycle 19 follow-up #3 (2026-04-28): TwinPod returns 200 (NOT 404) with
      // fabricated JSON-LD metadata for resources that don't exist. We can no
      // longer rely on `response.status === 404` to detect first-time users.
      // Instead, use Option C from Reference_Code_TwinPod-DefaultContainers.md:
      // a combined content-location + shape check. See
      // src/composables/util/twinpod-resource-exists.js.
      let parsedBody = null
      let isGenuineLedger = false
      if (response.ok) {
        try {
          parsedBody = await response.json()
        } catch {
          parsedBody = null
        }
        isGenuineLedger = parsedBody !== null && isRealTwinPodResource(
          response,
          parsedBody,
          d => typeof d?.balance === 'number'
        )
      }

      if (response.ok && isGenuineLedger) {
        const data = parsedBody
        balance.value = data.balance ?? 0
        ledger.value = data.ledger ?? []
        // Spec: Evo3a.TrialSchemaAndGate — null-safe: missing fields on existing
        // ledgers treated as false/null so existing users are not affected.
        trialUsed.value = data.trialUsed ?? false
        trialStartedAt.value = data.trialStartedAt ?? null
        console.info('[useCreditLedger] loadCredits — existing ledger loaded, balance:', balance.value)
      } else if (response.ok || response.status === 404) {
        // First-time user — pod has no ledger yet. Either the pod returned 404
        // (legacy / non-TwinPod servers) or 200 with fabricated metadata
        // (TwinPod). Both routes converge here.
        // Spec: Evo9.WebIDFreeCredit — whitelisted WebIDs get a 100K grant on first login.
        // Non-whitelisted users stay at 0 (existing trial flow applies).
        if (webId && FREE_CREDIT_WEBIDS.includes(webId)) {
          balance.value = FREE_CREDIT_AMOUNT
          const now = new Date().toISOString()
          const initialLedger = {
            balance: FREE_CREDIT_AMOUNT,
            ledger: [{ type: 'grant', credits: FREE_CREDIT_AMOUNT, reason: 'whitelist', ts: now }],
            processedEvents: [],
            updatedAt: now,
            trialUsed: false,
            trialStartedAt: null
          }
          ledger.value = initialLedger.ledger
          trialUsed.value = false
          trialStartedAt.value = null
          // Cycle 19 follow-up #5: whitelist branch matched.
          console.info('[useCreditLedger] whitelist grant applied — webId:', webId, 'balance set to:', FREE_CREDIT_AMOUNT)

          // Write the initial ledger to the pod so subsequent logins load it normally
          try {
            await ensureContainer(podRoot + '/apps/', fetcher, { slug: 'apps', label: 'Apps' })
            await ensureContainer(podRoot + '/apps/TomTwin/', fetcher, { slug: 'TomTwin', label: 'The Brain (Tom Twin) — App Data' })
            const putRes = await fetcher(ledgerUrl, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(initialLedger, null, 2)
            })
            if (putRes && putRes.ok === false) {
              console.warn('[useCreditLedger] whitelist grant PUT non-OK:', putRes.status)
            } else {
              console.info('[useCreditLedger] whitelist grant PUT ok')
            }
          } catch (writeErr) {
            // Non-fatal — balance is already set reactively; pod write is best-effort
            console.warn('[useCreditLedger] Whitelist grant pod write failed (non-fatal):', writeErr)
          }
        } else {
          // Non-whitelisted first-time user — use defaults (free trial flow)
          balance.value = 0
          ledger.value = []
          trialUsed.value = false
          trialStartedAt.value = null
          // Cycle 19 follow-up #5: whitelist branch did NOT match.
          const reason = !webId ? 'webId missing' : 'webId not in FREE_CREDIT_WEBIDS'
          console.info('[useCreditLedger] no whitelist grant — reason:', reason, 'webId:', webId || '(none)')
        }
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
      console.error('[useCreditLedger] startCheckout requires priceId and podRoot to be set', { priceId: !!priceId, _podRoot: !!_podRoot })
      // Show a visible error so the user sees feedback rather than silent failure.
      // Most common cause: this useCreditLedger instance was never initialised via
      // loadCredits (dual-instance / module dedup issue). See provide('startCheckout')
      // in App.vue — the injected version is always the correctly initialised instance.
      error.value = 'Checkout error — please reload and try again.'
      return
    }

    checkoutLoading.value = true
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
      // Note: checkoutLoading stays true through the Stripe redirect in the success path;
      // reset on error so the button re-enables after a failed attempt.
      checkoutLoading.value = false
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
          // Cycle 19 follow-up #3 (2026-04-28): TwinPod returns 200 with
          // fabricated metadata for non-existent resources. Verify the body
          // is a real ledger before consuming it; otherwise treat as
          // first-purchase and keep the empty default. Avoids zeroing a
          // credited user's ledger when the GET returns fabricated JSON-LD.
          let existing = null
          try { existing = await getRes.json() } catch { existing = null }
          if (existing && isRealTwinPodResource(getRes, existing, d => typeof d?.balance === 'number')) {
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
        }
        // 404 / fabricated 200 = no ledger yet — use empty (user's first purchase)
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
        await ensureContainer(_podRoot + '/apps/', authenticatedFetch, { slug: 'apps', label: 'Apps' })
        await ensureContainer(_podRoot + '/apps/TomTwin/', authenticatedFetch, { slug: 'TomTwin', label: 'The Brain (Tom Twin) — App Data' })

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

    // Cycle 19 follow-up #2 (2026-04-28): defensive guard against zeroing a credited
    // user's balance. A credited user (whitelist grant, recovery, purchase, carryover)
    // must NEVER have trial state written to their pod ledger. The App.vue watcher
    // already gates this via `if (creditBalance.value > 0) return`, but a stale
    // in-memory `balance.value` (mid-load race) or a transient pod GET failure
    // could otherwise let the spread fall back to balance=0 and clobber the real
    // ledger. This belt-and-suspenders check ensures the historical zeroing bug
    // cannot recur even if the upstream gate is bypassed.
    if (balance.value > 0) {
      console.warn('[useCreditLedger] writeTrialStart skipped — user has positive balance:', balance.value)
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
      let getSucceeded = false
      // getHttpOk is true whenever the HTTP layer gave us a definitive answer
      // (2xx or 404) — meaning we know the pod's state and a write is safe.
      // getSucceeded is only true when the body was a real ledger with a balance field.
      // The distinction matters because TwinPod fabricates 200 for non-existent resources
      // (instead of returning 404), so getSucceeded=false with getHttpOk=true means
      // "no real ledger exists yet" — safe to write. getHttpOk=false means an HTTP
      // error (5xx, 401, 403, network failure) — pod state is unknown, abort.
      let getHttpOk = false
      try {
        const getRes = await authenticatedFetch(ledgerUrl, {
          method: 'GET',
          headers: { 'Accept': 'application/json' }
        })
        // 2xx or 404 both mean "we know what's there" — safe to act on the result
        if (getRes.ok || getRes.status === 404) getHttpOk = true
        if (getRes.ok) {
          // Cycle 19 follow-up #3: TwinPod 200-not-404 quirk — only treat the
          // GET as a successful prove-balance read when the body is a real
          // ledger. A fabricated 200 with no `balance` field cannot prove
          // balance is 0, so getSucceeded stays false.
          let data = null
          try { data = await getRes.json() } catch { data = null }
          if (data && isRealTwinPodResource(getRes, data, d => typeof d?.balance === 'number')) {
            existing = { ...existing, ...data }
            getSucceeded = true
          }
        }
      } catch (e) {
        console.warn('[useCreditLedger] writeTrialStart GET failed (using in-memory state):', e)
      }

      // Cycle 19 follow-up #2 (2026-04-28): if the pod ledger reports a positive
      // balance, abort — this is a credited user and trial state must not be written.
      // The optimistic in-memory trialUsed/trialStartedAt updates are kept (the trial
      // is active server-side via KV); only the destructive pod write is suppressed.
      if (existing.balance > 0) {
        console.warn('[useCreditLedger] writeTrialStart aborted — pod ledger has positive balance:', existing.balance)
        // Sync in-memory balance to the pod-confirmed value so the App.vue gate
        // and the trial-timer computed wrapper see the credited state.
        balance.value = existing.balance
        return
      }
      // Bug fix (2026-05-01): was `if (!getSucceeded) return` — too aggressive.
      // A TwinPod fabricated 200 sets getHttpOk=true but getSucceeded=false (no real
      // ledger body). The old guard aborted the write for first-time users, so the
      // trial timestamp was never persisted to the pod. On every reload/login,
      // loadCredits() found no stored trial state and the Worker issued a fresh 10 min.
      // Fix: gate on getHttpOk (HTTP layer gave a definitive response) instead of
      // getSucceeded (real ledger was present). Only abort on true HTTP failures.
      if (!getHttpOk) {
        console.warn('[useCreditLedger] writeTrialStart aborted — GET request failed (5xx/401/403/network); pod state unknown, not writing')
        return
      }

      // Ensure parent containers exist
      await ensureContainer(_podRoot + '/apps/', authenticatedFetch, { slug: 'apps', label: 'Apps' })
      await ensureContainer(_podRoot + '/apps/TomTwin/', authenticatedFetch, { slug: 'TomTwin', label: 'The Brain (Tom Twin) — App Data' })

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
          // Cycle 19 follow-up #3: TwinPod 200-not-404 quirk — only spread
          // the GET body when it is a real ledger. Fabricated metadata has
          // no `balance` field; the spread would silently leave in-memory
          // values intact (which is the correct fallback anyway), but being
          // explicit makes the intent obvious and matches the pattern used
          // in loadCredits / applyPendingCredits / writeTrialStart.
          let data = null
          try { data = await getRes.json() } catch { data = null }
          if (data && isRealTwinPodResource(getRes, data, d => typeof d?.balance === 'number')) {
            existing = { ...existing, ...data }
          }
        }
      } catch (e) {
        console.warn('[useCreditLedger] decrementCredit GET failed (using in-memory state):', e)
      }

      // Apply debit to the freshly-read balance (guards against concurrent updates).
      // Use max(in-memory pre-decrement, pod) as the starting point: if the pod read
      // is stale (e.g. our recovery grant PUT hasn't landed yet), trust the in-memory
      // value; if another tab credited the user, use the higher pod value.
      const inMemoryPreDecrement = balance.value + amount  // optimistic was applied earlier
      const startBalance = Math.max(inMemoryPreDecrement, existing.balance ?? 0)
      const newBalance = Math.max(0, startBalance - amount)

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
    loading,           // tracks loadCredits / applyPendingCredits — used by App.vue timer mask
    checkoutLoading,   // tracks startCheckout only — used by BuyCreditsButton :disabled binding
    error,
    loadCredits,
    startCheckout,
    applyPendingCredits,
    writeTrialStart,
    decrementCredit
  }
}
