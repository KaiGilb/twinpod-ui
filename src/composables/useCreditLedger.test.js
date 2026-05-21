// UNIT_TYPE=Hook

// Spec: Evo9.WebIDFreeCredit — recovery / grant-on-top branch
//
// AC5 regression coverage for the Cycle 048 hotfix (2026-05-19) that restored
// the grant-on-top branch deleted in commit a57e01f. The branch lives inside
// the `if (response.ok && isGenuineLedger)` path in loadCredits and fires when:
//   - response is a real ledger (existing pod state)
//   - webId is whitelisted
//   - ledger contains no prior `grant` entry
// When it fires it adds FREE_CREDIT_AMOUNT on top of the existing balance,
// appends a `grant` ledger entry, and PUTs the updated ledger back to the pod
// preserving processedEvents / trialUsed / trialStartedAt.

import { describe, test, expect, vi, afterEach } from 'vitest'

// Mock ur.hyperFetch so no real network calls are made. The tests in this file
// always pass an authenticatedFetch (4th arg), so hyperFetch is never invoked,
// but the import must resolve.
const mockHyperFetch = vi.fn()
vi.mock('@kaigilb/twinpod-client', () => ({
  ur: {
    hyperFetch: (...args) => mockHyperFetch(...args)
  }
}))

afterEach(() => {
  vi.clearAllMocks()
  vi.resetModules()
})

// Helper: build a mock authenticatedFetch where each call returns the next response.
function makeAuthFetch(...responses) {
  let i = 0
  return vi.fn(async () => responses[i++] ?? { ok: true, status: 200 })
}

// Helper: build a "real" ledger GET response (shape-positive — isRealTwinPodResource
// returns true because the body carries a numeric `balance` field).
function realLedgerResponse(body) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => '/apps/TomTwin/thebrain-credits.json' },
    json: async () => body
  }
}

describe('useCreditLedger — Evo9.WebIDFreeCredit grant-on-top branch (Cycle 048 regression)', () => {

  // AC1 + AC2: whitelisted user + existing ledger (balance 500) + no prior grant
  //  → new balance is 100,500; ledger gains a grant entry; PUT is called with the
  //    updated ledger preserving processedEvents / trialUsed / trialStartedAt.
  test('whitelisted user + existing ledger balance 500 + no prior grant → balance becomes 100,500 and PUT fires', async () => {
    const { useCreditLedger } = await import('./useCreditLedger.js')

    const existing = {
      balance: 500,
      ledger: [{ type: 'purchase', credits: 500, stripeSessionId: 'cs_paid', ts: '2026-05-01T09:00:00Z' }],
      processedEvents: ['cs_paid'],
      updatedAt: '2026-05-01T09:00:00Z',
      trialUsed: false,
      trialStartedAt: null
    }

    // GET ledger → real ledger; HEAD /apps/ → exists; HEAD /apps/TomTwin/ → exists; PUT updated ledger
    const auth = makeAuthFetch(
      realLedgerResponse(existing),
      { ok: true, status: 200 },
      { ok: true, status: 200 },
      { ok: true, status: 200 }
    )

    const { balance, ledger, loadCredits } = useCreditLedger()
    await loadCredits(
      'https://tst-plannereu.twinpod.eu',
      'tok',
      auth,
      'https://tst-plannereu.twinpod.eu/i'
    )

    // AC2: grant-on-top — 500 + 100000 = 100500
    expect(balance.value).toBe(100500)
    // AC2: original purchase entry preserved AND a new grant entry appended
    expect(ledger.value).toHaveLength(2)
    expect(ledger.value[0].type).toBe('purchase')
    expect(ledger.value[1].type).toBe('grant')
    expect(ledger.value[1].credits).toBe(100000)
    expect(ledger.value[1].reason).toBe('whitelist')

    // AC2: PUT must have been called with the updated ledger preserving
    //      processedEvents / trialUsed / trialStartedAt
    const putCall = auth.mock.calls.find(c => c[1]?.method === 'PUT')
    expect(putCall).toBeDefined()
    const body = JSON.parse(putCall[1].body)
    expect(body.balance).toBe(100500)
    expect(body.processedEvents).toEqual(['cs_paid'])
    expect(body.trialUsed).toBe(false)
    expect(body.trialStartedAt).toBeNull()
    expect(body.ledger).toHaveLength(2)
    expect(body.ledger[1].type).toBe('grant')
  })

  // AC3: idempotency — re-running loadCredits for a whitelisted user whose
  //      existing ledger ALREADY contains a `grant` entry does not add another
  //      grant and does not PUT.
  test('whitelisted user + existing ledger that already has a grant entry → no change, no PUT', async () => {
    const { useCreditLedger } = await import('./useCreditLedger.js')

    const alreadyGranted = {
      balance: 100500,
      ledger: [
        { type: 'purchase', credits: 500, stripeSessionId: 'cs_paid', ts: '2026-05-01T09:00:00Z' },
        { type: 'grant', credits: 100000, reason: 'whitelist', ts: '2026-05-02T09:00:00Z' }
      ],
      processedEvents: ['cs_paid'],
      updatedAt: '2026-05-02T09:00:00Z',
      trialUsed: false,
      trialStartedAt: null
    }

    const auth = makeAuthFetch(realLedgerResponse(alreadyGranted))

    const { balance, ledger, loadCredits } = useCreditLedger()
    await loadCredits(
      'https://tst-plannereu.twinpod.eu',
      'tok',
      auth,
      'https://tst-plannereu.twinpod.eu/i'
    )

    // AC3: no change to balance or ledger
    expect(balance.value).toBe(100500)
    expect(ledger.value).toHaveLength(2)
    // AC3: no PUT issued
    const putCall = auth.mock.calls.find(c => c[1]?.method === 'PUT')
    expect(putCall).toBeUndefined()
  })

  // AC4: non-whitelisted users with existing ledgers are unaffected — no grant, no PUT
  test('non-whitelisted user + existing ledger → unchanged, no PUT', async () => {
    const { useCreditLedger } = await import('./useCreditLedger.js')

    const existing = {
      balance: 7500,
      ledger: [{ type: 'purchase', credits: 7500, stripeSessionId: 'cs_x', ts: '2026-05-01T09:00:00Z' }],
      processedEvents: ['cs_x'],
      updatedAt: '2026-05-01T09:00:00Z',
      trialUsed: false,
      trialStartedAt: null
    }

    const auth = makeAuthFetch(realLedgerResponse(existing))

    const { balance, ledger, loadCredits } = useCreditLedger()
    await loadCredits(
      'https://stranger.demo.systemtwin.com',
      'tok',
      auth,
      'https://stranger.demo.systemtwin.com/i'
    )

    expect(balance.value).toBe(7500)
    expect(ledger.value).toHaveLength(1)
    const putCall = auth.mock.calls.find(c => c[1]?.method === 'PUT')
    expect(putCall).toBeUndefined()
  })

})
