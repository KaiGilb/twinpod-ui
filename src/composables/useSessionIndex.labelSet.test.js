// UNIT_TYPE=Hook
//
// Cycle 066-extended rev2 (2026-06-04) — ensureContainer pre-creation for
// TomTwinProjects/ and each project <id>/ folder.
//
// Replaces the prior patchInsert-based label-set approach (a181e14) which
// returned 401 on tst-plan.twinpod.eu. The ensureContainer approach:
//   - HEAD-checks the container before any file write.
//   - On 404: PUTs the container with BasicContainer Link header + rdfs:label body.
//   - On 200 (already exists): no-op.
//   - On failure: logs a warning, never blocks the save path.
//
// Spec: F.EnsureContainer (tst-planlegger 409 fix + label-at-creation defense-in-depth).
//       Reference_Code_TwinPod-DefaultContainers-quirks.md § container pre-creation.
//
// Verifies:
//   - createNewSession() calls ensureContainer for TomTwinProjects/ BEFORE saveIndex().
//   - HEAD returns 200 → no-op (no PUT issued).
//   - HEAD returns 404 → PUT issued with BasicContainer Link header and rdfs:label body.
//   - Second createNewSession() does NOT re-attempt the root container (one-time guard).
//   - saveCurrentSession() calls ensureContainer for the project <id>/ folder BEFORE
//     the content.json PUT.
//   - Second saveCurrentSession() for the same id does NOT re-attempt (one-time guard).
//   - ensureContainer failure (throws) is swallowed: save path is unaffected.

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { ref } from 'vue'

// --- Mocks ---

const mockHyperFetch = vi.fn()
const mockUploadFile = vi.fn()
const mockPatchInsert = vi.fn()
const mockEnqueueSave = vi.fn()
const mockDeleteURI = vi.fn().mockResolvedValue(true)
const _saveListeners = new Set()

vi.mock('@kaigilb/twinpod-client', () => ({
  ur: {
    hyperFetch: mockHyperFetch,
    uploadFile: mockUploadFile,
    patchInsert: mockPatchInsert,
    enqueueSave: mockEnqueueSave,
    deleteURI: mockDeleteURI,
    onSaveEvent: vi.fn((fn) => {
      _saveListeners.add(fn)
      return () => _saveListeners.delete(fn)
    })
  }
}))

// In-memory localStorage shim.
const _store = new Map()
const fakeLocalStorage = {
  getItem: (k) => (_store.has(k) ? _store.get(k) : null),
  setItem: (k, v) => { _store.set(k, String(v)) },
  removeItem: (k) => { _store.delete(k) },
  clear: () => { _store.clear() }
}
if (typeof globalThis.window === 'undefined') {
  globalThis.window = { localStorage: fakeLocalStorage }
} else {
  globalThis.window.localStorage = fakeLocalStorage
}

// window.solid.session.fetch mock — injected per test.
let mockSessionFetch

const POD_ROOT = 'https://tst-ensure.example'
const ROOT = `${POD_ROOT}/home/TomTwinProjects`

function jsonResponse(obj, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(obj) }
}
function notFound() {
  return { ok: false, status: 404, text: async () => '' }
}
function headOk() {
  return { ok: true, status: 200 }
}
function headNotFound() {
  return { ok: false, status: 404 }
}
function putCreated() {
  return { ok: true, status: 201 }
}

// ─────────────────────────────────────────────────────────────────────────────

describe('useSessionIndex — ensureContainer (Cycle 066-extended rev2)', () => {
  let document
  let useSessionIndex
  let _resetModuleStateForTesting

  beforeEach(async () => {
    vi.resetModules()
    const mod = await import('./useSessionIndex.js')
    useSessionIndex = mod.useSessionIndex
    _resetModuleStateForTesting = mod._resetModuleStateForTesting
    _resetModuleStateForTesting()
    _store.clear()

    document = ref('')
    mockHyperFetch.mockReset()
    mockUploadFile.mockReset()
    mockPatchInsert.mockReset()
    mockSessionFetch = vi.fn()

    // Wire window.solid.session.fetch for ensureContainer.
    globalThis.window.solid = { session: { fetch: mockSessionFetch } }

    // Default: all file/index writes succeed.
    mockUploadFile.mockResolvedValue({ ok: true, status: 201 })
    // Default: index.json reads as 404 (first use).
    mockHyperFetch.mockResolvedValue(notFound())
    // Default: HEAD → 200 (container already exists) — no-op path.
    mockSessionFetch.mockResolvedValue(headOk())
  })

  afterEach(() => {
    vi.resetModules()
    delete globalThis.window.solid
  })

  // ── Root container (TomTwinProjects/) ────────────────────────────────────

  test('createNewSession — HEAD 200 → no PUT issued (no-op path)', async () => {
    mockSessionFetch.mockResolvedValue(headOk())

    const { createNewSession, setPodRoot } = useSessionIndex({ document })
    setPodRoot(POD_ROOT)
    await createNewSession()

    const headCalls = mockSessionFetch.mock.calls.filter(([, opts]) => opts?.method === 'HEAD')
    expect(headCalls.length).toBe(1)
    expect(headCalls[0][0]).toBe(`${ROOT}/`)

    const putCalls = mockSessionFetch.mock.calls.filter(([, opts]) => opts?.method === 'PUT')
    expect(putCalls.length).toBe(0)
  })

  test('createNewSession — HEAD 404 → PUT issued with BasicContainer Link header', async () => {
    mockSessionFetch
      .mockResolvedValueOnce(headNotFound()) // HEAD
      .mockResolvedValueOnce(putCreated())   // PUT

    const { createNewSession, setPodRoot } = useSessionIndex({ document })
    setPodRoot(POD_ROOT)
    await createNewSession()

    const putCalls = mockSessionFetch.mock.calls.filter(([, opts]) => opts?.method === 'PUT')
    expect(putCalls.length).toBe(1)
    const [url, opts] = putCalls[0]
    expect(url).toBe(`${ROOT}/`)
    expect(opts.headers['Link']).toBe('<http://www.w3.org/ns/ldp#BasicContainer>; rel="type"')
    expect(opts.headers['Content-Type']).toBe('text/turtle')
  })

  test('createNewSession — HEAD 404 → PUT body contains rdfs:label "TomTwinProjects"', async () => {
    mockSessionFetch
      .mockResolvedValueOnce(headNotFound())
      .mockResolvedValueOnce(putCreated())

    const { createNewSession, setPodRoot } = useSessionIndex({ document })
    setPodRoot(POD_ROOT)
    await createNewSession()

    const putCalls = mockSessionFetch.mock.calls.filter(([, opts]) => opts?.method === 'PUT')
    expect(putCalls[0][1].body).toContain('rdfs:label')
    expect(putCalls[0][1].body).toContain('TomTwinProjects')
  })

  test('createNewSession — ensureContainer fires BEFORE saveIndex (index PUT succeeds after 404→create)', async () => {
    // Simulate: HEAD root → 404 (needs create), PUT root → 201 (created),
    //           then index.json PUT goes via mockUploadFile.
    const callOrder = []
    mockSessionFetch.mockImplementation((url, opts) => {
      if (opts?.method === 'HEAD') { callOrder.push('HEAD'); return headNotFound() }
      if (opts?.method === 'PUT')  { callOrder.push('PUT');  return putCreated() }
      return headOk()
    })
    mockUploadFile.mockImplementation(() => { callOrder.push('uploadFile'); return { ok: true, status: 201 } })

    const { createNewSession, setPodRoot } = useSessionIndex({ document })
    setPodRoot(POD_ROOT)
    await createNewSession()

    // ensureContainer (HEAD + PUT) must precede saveIndex's uploadFile call.
    expect(callOrder[0]).toBe('HEAD')
    expect(callOrder[1]).toBe('PUT')
    expect(callOrder[2]).toBe('uploadFile')
  })

  test('second createNewSession does NOT re-attempt root container (one-time guard)', async () => {
    mockSessionFetch.mockResolvedValue(headOk())

    const { createNewSession, setPodRoot } = useSessionIndex({ document })
    setPodRoot(POD_ROOT)

    await createNewSession()
    const headAfterFirst = mockSessionFetch.mock.calls.filter(([, opts]) => opts?.method === 'HEAD').length

    await createNewSession()
    const headAfterSecond = mockSessionFetch.mock.calls.filter(([, opts]) => opts?.method === 'HEAD').length

    expect(headAfterFirst).toBe(1)
    expect(headAfterSecond).toBe(1) // No new HEAD on second call.
  })

  // ── Project folder (<id>/) ───────────────────────────────────────────────

  test('saveCurrentSession — HEAD 200 → no PUT issued for project folder (no-op path)', async () => {
    mockSessionFetch.mockResolvedValue(headOk())

    const { createNewSession, saveCurrentSession, setPodRoot, activeSessionId } = useSessionIndex({ document })
    setPodRoot(POD_ROOT)
    await createNewSession()
    const id = activeSessionId.value

    // Reset to track only the saveCurrentSession ensureContainer call.
    mockSessionFetch.mockClear()
    mockSessionFetch.mockResolvedValue(headOk())

    document.value = 'some content'
    await saveCurrentSession('My Project')

    const headCalls = mockSessionFetch.mock.calls.filter(([, opts]) => opts?.method === 'HEAD')
    expect(headCalls.length).toBe(1)
    expect(headCalls[0][0]).toBe(`${ROOT}/${id}/`)

    const putCalls = mockSessionFetch.mock.calls.filter(([, opts]) => opts?.method === 'PUT')
    expect(putCalls.length).toBe(0)
  })

  test('saveCurrentSession — HEAD 404 → PUT issued for project folder with BasicContainer Link header', async () => {
    // Root container: HEAD 200 (no-op). Project folder: HEAD 404 (needs create).
    let callCount = 0
    mockSessionFetch.mockImplementation((url, opts) => {
      if (opts?.method === 'HEAD') {
        callCount++
        if (callCount === 1) return headOk()     // root container (createNewSession)
        return headNotFound()                     // project folder (saveCurrentSession)
      }
      return putCreated()
    })

    const { createNewSession, saveCurrentSession, setPodRoot, activeSessionId } = useSessionIndex({ document })
    setPodRoot(POD_ROOT)
    await createNewSession()
    const id = activeSessionId.value

    document.value = 'content'
    await saveCurrentSession('My Project')

    const putCalls = mockSessionFetch.mock.calls.filter(([, opts]) => opts?.method === 'PUT')
    expect(putCalls.length).toBe(1)
    const [url, opts] = putCalls[0]
    expect(url).toBe(`${ROOT}/${id}/`)
    expect(opts.headers['Link']).toBe('<http://www.w3.org/ns/ldp#BasicContainer>; rel="type"')
  })

  test('saveCurrentSession — HEAD 404 → PUT body contains rdfs:label with project name', async () => {
    let headCount = 0
    mockSessionFetch.mockImplementation((url, opts) => {
      if (opts?.method === 'HEAD') {
        headCount++
        if (headCount === 1) return headOk()   // root
        return headNotFound()                   // project folder
      }
      return putCreated()
    })

    const { createNewSession, renameSession, saveCurrentSession, setPodRoot, activeSessionId } = useSessionIndex({ document })
    setPodRoot(POD_ROOT)
    await createNewSession()
    const id = activeSessionId.value
    await renameSession(id, 'My Test Project')

    document.value = 'hello'
    await saveCurrentSession('My Test Project')

    const putCalls = mockSessionFetch.mock.calls.filter(([, opts]) => opts?.method === 'PUT')
    expect(putCalls.length).toBe(1)
    expect(putCalls[0][1].body).toContain('rdfs:label')
    expect(putCalls[0][1].body).toContain('My Test Project')
  })

  test('saveCurrentSession — ensureContainer fires BEFORE content.json PUT', async () => {
    const callOrder = []
    let headCount = 0
    mockSessionFetch.mockImplementation((url, opts) => {
      if (opts?.method === 'HEAD') {
        callOrder.push('HEAD')
        headCount++
        if (headCount === 1) return headOk() // root container
        return headNotFound()               // project folder
      }
      if (opts?.method === 'PUT') { callOrder.push('PUT-container'); return putCreated() }
      return headOk()
    })
    mockUploadFile.mockImplementation(() => {
      callOrder.push('uploadFile')
      return { ok: true, status: 201 }
    })

    const { createNewSession, saveCurrentSession, setPodRoot } = useSessionIndex({ document })
    setPodRoot(POD_ROOT)
    await createNewSession()

    callOrder.length = 0 // reset after createNewSession
    document.value = 'text'
    await saveCurrentSession('Test')

    // HEAD (project folder) → PUT (container) → uploadFile (content.json) order required.
    expect(callOrder[0]).toBe('HEAD')
    expect(callOrder[1]).toBe('PUT-container')
    expect(callOrder.some(e => e === 'uploadFile')).toBe(true)
    const putsBeforeUpload = callOrder.indexOf('uploadFile')
    expect(callOrder.indexOf('PUT-container')).toBeLessThan(putsBeforeUpload)
  })

  test('second saveCurrentSession for same id does NOT re-attempt project folder (one-time guard)', async () => {
    mockSessionFetch.mockResolvedValue(headOk())

    const { createNewSession, saveCurrentSession, setPodRoot, activeSessionId } = useSessionIndex({ document })
    setPodRoot(POD_ROOT)
    await createNewSession()
    const id = activeSessionId.value

    mockSessionFetch.mockClear()
    mockSessionFetch.mockResolvedValue(headOk())

    document.value = 'first'
    await saveCurrentSession('P1')
    const headsAfterFirst = mockSessionFetch.mock.calls.filter(([, opts]) => opts?.method === 'HEAD').length

    mockSessionFetch.mockClear()
    document.value = 'second'
    await saveCurrentSession('P1')
    const headsAfterSecond = mockSessionFetch.mock.calls.filter(([, opts]) => opts?.method === 'HEAD').length

    expect(headsAfterFirst).toBe(1)   // one HEAD on first save
    expect(headsAfterSecond).toBe(0)  // no HEAD on second save (already ensured)
  })

  // ── Resilience ───────────────────────────────────────────────────────────

  test('ensureContainer failure (throws) does not throw and does not break save path', async () => {
    // Simulate ensureContainer throwing (e.g. network error).
    mockSessionFetch.mockRejectedValue(new Error('network error'))

    const { createNewSession, saveCurrentSession, setPodRoot, sessionSaveError, activeSessionId } = useSessionIndex({ document })
    setPodRoot(POD_ROOT)

    // createNewSession must succeed despite ensureContainer throwing.
    await expect(createNewSession()).resolves.not.toThrow()
    expect(sessionSaveError.value).toBeNull()

    // saveCurrentSession must also succeed.
    document.value = 'content'
    await expect(saveCurrentSession('Test')).resolves.not.toThrow()
    expect(sessionSaveError.value).toBeNull()
  })

  test('patchInsert is NOT called (old label-set approach removed)', async () => {
    mockSessionFetch.mockResolvedValue(headOk())

    const { createNewSession, saveCurrentSession, setPodRoot } = useSessionIndex({ document })
    setPodRoot(POD_ROOT)
    await createNewSession()
    document.value = 'abc'
    await saveCurrentSession('P')

    expect(mockPatchInsert).not.toHaveBeenCalled()
  })
})
