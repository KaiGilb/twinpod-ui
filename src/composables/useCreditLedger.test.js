// UNIT_TYPE=Hook

// Spec: Evo9.WebIDFreeCredit — recovery / grant-on-top branch
//
// AC5 regression coverage for the Cycle 048 hotfix (2026-05-19) that restored
// the grant-on-top branch deleted in commit a57e01f. The grant-on-top branch
// fires in loadCredits when:
//   - response is a real ledger (existing pod state)
//   - webId is whitelisted
//   - ledger contains no prior `grant` entry
// When it fires it adds FREE_CREDIT_AMOUNT on top of the existing balance,
// appends a `grant` ledger entry, and PUTs the updated ledger back to the pod
// preserving processedEvents / trialUsed / trialStartedAt.
//
// BareFileSave 2026-05-23 — Group 5: PUTs now route through the canonical
// queue (ur.enqueueSave + ur.uploadJSON). Tests assert the queued task
// produces the same body the legacy direct-PUT used to produce.

import { describe, test, expect, vi, afterEach, beforeEach } from 'vitest'

// Drive ur.enqueueSave synchronously: run the task immediately and emit
// succeeded/failed events through ur.onSaveEvent so the awaiting composable
// resolves on the same tick the test is inspecting.
const _saveListeners = new Set()
function _emitSave(evt) {
  for (const l of [..._saveListeners]) l(evt)
}

const mockUploadJSON = vi.fn()
const mockReadJSON = vi.fn()
const mockHyperFetch = vi.fn()
const mockEnsureContainer = vi.fn().mockResolvedValue(undefined)
const mockEnqueueSave = vi.fn()

vi.mock('@kaigilb/twinpod-client', () => ({
  ur: {
    hyperFetch: mockHyperFetch,
    uploadJSON: mockUploadJSON,
    readJSON: mockReadJSON,
    ensureContainer: mockEnsureContainer,
    enqueueSave: mockEnqueueSave,
    onSaveEvent: vi.fn((fn) => {
      _saveListeners.add(fn)
      return () => _saveListeners.delete(fn)
    })
  }
}))

beforeEach(() => {
  vi.clearAllMocks()
  _saveListeners.clear()
  // Default queue behaviour: run task synchronously and emit succeeded.
  mockEnqueueSave.mockImplementation(({ task, resourceKey, label }) => {
    const id = `test-${Math.random().toString(36).slice(2, 8)}`
    queueMicrotask(async () => {
      try {
        const result = await task()
        _emitSave({ type: 'succeeded', id, resourceKey, label, result })
      } catch (error) {
        _emitSave({ type: 'failed', id, resourceKey, label, error })
      }
    })
    return id
  })
  mockEnsureContainer.mockResolvedValue(undefined)
})

afterEach(() => {
  vi.clearAllMocks()
  vi.resetModules()
  _saveListeners.clear()
})

// Helper: build a mock authenticatedFetch where each call returns the next response.
function makeAuthFetch(...responses) {
  let i = 0
  return vi.fn(async () => responses[i++] ?? { ok: true, status: 200 })
}

// Helper: build a "real" ledger GET response.
function realLedgerResponse(body) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => '/apps/TomTwin/thebrain-credits.json' },
    json: async () => body
  }
}

describe('useCreditLedger — Evo9.WebIDFreeCredit grant-on-top branch (Cycle 048 regression)', () => {

  test('whitelisted user + existing ledger balance 500 + no prior grant → balance becomes 100,500 and uploadJSON fires', async () => {
    const { useCreditLedger } = await import('./useCreditLedger.js')

    const existing = {
      balance: 500,
      ledger: [{ type: 'purchase', credits: 500, stripeSessionId: 'cs_paid', ts: '2026-05-01T09:00:00Z' }],
      processedEvents: ['cs_paid'],
      updatedAt: '2026-05-01T09:00:00Z',
      trialUsed: false,
      trialStartedAt: null
    }

    // GET ledger via authenticatedFetch (read path unchanged) → real ledger.
    // ensureContainer is mocked at module level (no auth calls used).
    const auth = makeAuthFetch(realLedgerResponse(existing))

    // PUT via ur.uploadJSON (BareFileSave 2026-05-23).
    mockUploadJSON.mockResolvedValueOnce({ ok: true, status: 200 })

    const { balance, ledger, loadCredits } = useCreditLedger()
    await loadCredits(
      'https://tst-plannereu.twinpod.eu',
      'tok',
      auth,
      'https://tst-plannereu.twinpod.eu/i'
    )

    // 500 + 100000 = 100500
    expect(balance.value).toBe(100500)
    expect(ledger.value).toHaveLength(2)
    expect(ledger.value[0].type).toBe('purchase')
    expect(ledger.value[1].type).toBe('grant')
    expect(ledger.value[1].credits).toBe(100000)
    expect(ledger.value[1].reason).toBe('whitelist')

    // uploadJSON must have been called with the updated ledger.
    expect(mockUploadJSON).toHaveBeenCalledTimes(1)
    const [putUrl, putBodyRaw] = mockUploadJSON.mock.calls[0]
    expect(putUrl).toBe('https://tst-plannereu.twinpod.eu/apps/TomTwin/thebrain-credits.json')
    const body = JSON.parse(putBodyRaw)
    expect(body.balance).toBe(100500)
    expect(body.processedEvents).toEqual(['cs_paid'])
    expect(body.trialUsed).toBe(false)
    expect(body.trialStartedAt).toBeNull()
    expect(body.ledger).toHaveLength(2)
    expect(body.ledger[1].type).toBe('grant')

    // Queue was used with the canonical resourceKey.
    expect(mockEnqueueSave).toHaveBeenCalledWith(
      expect.objectContaining({
        resourceKey: 'https://tst-plannereu.twinpod.eu/apps/TomTwin/thebrain-credits.json'
      })
    )
  })

  test('whitelisted user + existing ledger that already has a grant entry → no change, no uploadJSON', async () => {
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

    expect(balance.value).toBe(100500)
    expect(ledger.value).toHaveLength(2)
    expect(mockUploadJSON).not.toHaveBeenCalled()
  })

  test('non-whitelisted user + existing ledger → unchanged, no uploadJSON', async () => {
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
    expect(mockUploadJSON).not.toHaveBeenCalled()
  })

})

// Item 7 (2026-05-29) — credit-based free trial. A new, non-whitelisted user
// with no existing pod ledger is granted INITIAL_FREE_CREDITS up front; the
// grant is written to the pod with trialUsed=true so it is given exactly once.
describe('useCreditLedger — credit-based free-trial grant (item 7)', () => {

  // Helper: a 404 ledger GET (no pod ledger yet = first-time user).
  function ledger404Response() {
    return {
      ok: false,
      status: 404,
      headers: { get: () => null },
      json: async () => ({})
    }
  }

  test('non-whitelisted first-time user (404) → balance becomes INITIAL_FREE_CREDITS, trialUsed=true, uploadJSON fires', async () => {
    const { useCreditLedger } = await import('./useCreditLedger.js')

    const auth = makeAuthFetch(ledger404Response())
    mockUploadJSON.mockResolvedValueOnce({ ok: true, status: 200 })

    const { balance, ledger, trialUsed, loadCredits } = useCreditLedger()
    await loadCredits(
      'https://newbie.demo.systemtwin.com',
      'tok',
      auth,
      'https://newbie.demo.systemtwin.com/i'
    )

    // The default allotment is 150 credits (the single tuning knob in the source).
    expect(balance.value).toBe(150)
    // Grant is marked given so the gate (balance===0 && trialUsed) fires once spent.
    expect(trialUsed.value).toBe(true)
    expect(ledger.value).toHaveLength(1)
    expect(ledger.value[0].type).toBe('grant')
    expect(ledger.value[0].reason).toBe('free-trial')
    expect(ledger.value[0].credits).toBe(150)

    // The grant is persisted to the pod so a returning user is not re-granted.
    expect(mockUploadJSON).toHaveBeenCalledTimes(1)
    const [putUrl, putBodyRaw] = mockUploadJSON.mock.calls[0]
    expect(putUrl).toBe('https://newbie.demo.systemtwin.com/apps/TomTwin/thebrain-credits.json')
    const body = JSON.parse(putBodyRaw)
    expect(body.balance).toBe(150)
    expect(body.trialUsed).toBe(true)
    expect(body.ledger[0].reason).toBe('free-trial')

    // Queue used the canonical ledger-URL resourceKey.
    expect(mockEnqueueSave).toHaveBeenCalledWith(
      expect.objectContaining({
        resourceKey: 'https://newbie.demo.systemtwin.com/apps/TomTwin/thebrain-credits.json'
      })
    )
  })

  test('returning user who spent the grant (balance 0, trialUsed true) → unchanged, NOT re-granted', async () => {
    const { useCreditLedger } = await import('./useCreditLedger.js')

    const spent = {
      balance: 0,
      ledger: [{ type: 'grant', credits: 50, reason: 'free-trial', ts: '2026-05-29T09:00:00Z' }],
      processedEvents: [],
      updatedAt: '2026-05-29T10:00:00Z',
      trialUsed: true,
      trialStartedAt: null
    }
    const auth = makeAuthFetch(realLedgerResponse(spent))

    const { balance, trialUsed, loadCredits } = useCreditLedger()
    await loadCredits(
      'https://newbie.demo.systemtwin.com',
      'tok',
      auth,
      'https://newbie.demo.systemtwin.com/i'
    )

    // Existing ledger is loaded as-is — no fresh grant, no pod write.
    expect(balance.value).toBe(0)
    expect(trialUsed.value).toBe(true)
    expect(mockUploadJSON).not.toHaveBeenCalled()
  })

})

// Apps-container clean-label fix (Cycle 066-extended, 2026-06-04) — the
// /apps/TomTwin/ container must be created with the AUTHORITATIVE captured wire
// recipe so the LaunchPad shows a clean label (no leading-comma ",TomTwin,apps,").
// Mirrors the sibling fix in useSessionIndex.js _ensureContainer (commit baa3963).
//
// The local ensureContainer issues HEAD first; on 404 it PUTs the container with
// Content-Type: text/turtle, body `<> rdfs:label "<Name>" .`, NO Slug header,
// trailing-slash URL. The PUT goes through the authenticatedFetch passed by the
// caller (NOT ur.ensureContainer — that mock is unused scaffolding here).
describe('useCreditLedger — /apps/TomTwin/ container clean-label PUT (Cycle 066-extended)', () => {

  // authenticatedFetch that: GET → 404 ledger (first-time user, drives the grant
  // branch which calls ensureContainer); HEAD → 404 (container missing, drives the
  // create PUT); PUT (container) → 201. The ledger JSON PUT goes through ur.uploadJSON,
  // not this fetch, so it is not seen here.
  function makeContainerAwareFetch() {
    return vi.fn(async (url, opts = {}) => {
      if (opts.method === 'HEAD') return { ok: false, status: 404 }
      if (opts.method === 'PUT') return { ok: true, status: 201 }
      // GET ledger → 404 (no ledger yet) so the whitelist-initial branch fires.
      return { ok: false, status: 404, headers: { get: () => null }, json: async () => ({}) }
    })
  }

  test('whitelisted first-time user → /apps/TomTwin/ PUT body is `<> rdfs:label "TomTwin" .`, text/turtle, NO Slug, trailing slash', async () => {
    const { useCreditLedger } = await import('./useCreditLedger.js')

    const podRoot = 'https://tst-plannereu.twinpod.eu'
    const auth = makeContainerAwareFetch()
    mockUploadJSON.mockResolvedValueOnce({ ok: true, status: 200 })

    const { loadCredits } = useCreditLedger()
    await loadCredits(podRoot, 'tok', auth, podRoot + '/i')

    // Find the PUT to the /apps/TomTwin/ container (order-independent).
    const tomTwinPut = auth.mock.calls.find(
      ([u, o]) => u === podRoot + '/apps/TomTwin/' && o?.method === 'PUT'
    )
    expect(tomTwinPut).toBeDefined()
    const [putUrl, putInit] = tomTwinPut

    // Trailing slash (LDP container signal).
    expect(putUrl.endsWith('/')).toBe(true)
    // Bare captured-wire body — no @prefix line, label is the path segment "TomTwin".
    expect(putInit.body).toBe('<> rdfs:label "TomTwin" .')
    // text/turtle content type.
    expect(putInit.headers['Content-Type']).toBe('text/turtle')
    // NO Slug header — Slug on PUT creates a child INSIDE the container (doubling bug).
    expect('Slug' in putInit.headers).toBe(false)
  })

  test('parent /apps/ container is labeled "Apps" (default pod container name)', async () => {
    const { useCreditLedger } = await import('./useCreditLedger.js')

    const podRoot = 'https://tst-plannereu.twinpod.eu'
    const auth = makeContainerAwareFetch()
    mockUploadJSON.mockResolvedValueOnce({ ok: true, status: 200 })

    const { loadCredits } = useCreditLedger()
    await loadCredits(podRoot, 'tok', auth, podRoot + '/i')

    const appsPut = auth.mock.calls.find(
      ([u, o]) => u === podRoot + '/apps/' && o?.method === 'PUT'
    )
    expect(appsPut).toBeDefined()
    const [, putInit] = appsPut
    expect(putInit.body).toBe('<> rdfs:label "Apps" .')
    expect('Slug' in putInit.headers).toBe(false)
  })

})

describe('useCreditLedger — Group 5 queue routing (BareFileSave 2026-05-23)', () => {

  test('Guard C — localStorage backup is written BEFORE enqueue and cleared on success', async () => {
    const { useCreditLedger } = await import('./useCreditLedger.js')

    const mockStorage = {}
    const lsMock = {
      getItem: vi.fn((k) => mockStorage[k] || null),
      setItem: vi.fn((k, v) => { mockStorage[k] = v }),
      removeItem: vi.fn((k) => { delete mockStorage[k] })
    }
    const originalWindow = globalThis.window
    globalThis.window = { localStorage: lsMock }

    const existing = {
      balance: 500,
      ledger: [{ type: 'purchase', credits: 500, stripeSessionId: 'cs', ts: '2026-05-01T09:00:00Z' }],
      processedEvents: ['cs'],
      updatedAt: '2026-05-01T09:00:00Z',
      trialUsed: false,
      trialStartedAt: null
    }
    const auth = makeAuthFetch(realLedgerResponse(existing))
    mockUploadJSON.mockResolvedValueOnce({ ok: true, status: 200 })

    const { loadCredits } = useCreditLedger()
    await loadCredits(
      'https://tst-plannereu.twinpod.eu',
      'tok',
      auth,
      'https://tst-plannereu.twinpod.eu/i'
    )

    expect(lsMock.setItem).toHaveBeenCalledWith(
      'theBrain.creditLedgerBackup',
      expect.any(String)
    )
    expect(lsMock.removeItem).toHaveBeenCalledWith('theBrain.creditLedgerBackup')

    if (originalWindow !== undefined) globalThis.window = originalWindow
    else delete globalThis.window
  })

  test('queue routing uses the canonical ledger-URL resourceKey (whitelist-grant path)', async () => {
    // Structural invariant: every enqueueSave call from useCreditLedger uses
    // the ledger URL as resourceKey so FIFO serialisation applies across all
    // four write paths. This test only directly exercises the whitelist-grant-
    // on-top path; the other three paths (applyPendingCredits / writeTrialStart
    // / decrementCredit) all call _enqueueLedgerWrite with the same ledgerUrl
    // constant — verified by file inspection but not enumerated here.
    const { useCreditLedger } = await import('./useCreditLedger.js')
    const podRoot = 'https://tst-plannereu.twinpod.eu'
    const ledgerUrl = podRoot + '/apps/TomTwin/thebrain-credits.json'

    // Drive a whitelist-grant-on-top path:
    const existing = {
      balance: 500,
      ledger: [{ type: 'purchase', credits: 500, stripeSessionId: 'cs', ts: '2026-05-01T09:00:00Z' }],
      processedEvents: ['cs'],
      updatedAt: '2026-05-01T09:00:00Z',
      trialUsed: false,
      trialStartedAt: null
    }
    const auth = makeAuthFetch(realLedgerResponse(existing))
    mockUploadJSON.mockResolvedValueOnce({ ok: true, status: 200 })

    const { loadCredits } = useCreditLedger()
    await loadCredits(podRoot, 'tok', auth, podRoot + '/i')

    const enqueueCalls = mockEnqueueSave.mock.calls
    expect(enqueueCalls.length).toBeGreaterThan(0)
    for (const [opts] of enqueueCalls) {
      expect(opts.resourceKey).toBe(ledgerUrl)
    }
  })

})
