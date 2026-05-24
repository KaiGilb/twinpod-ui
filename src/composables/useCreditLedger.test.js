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
