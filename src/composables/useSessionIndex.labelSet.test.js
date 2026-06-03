// UNIT_TYPE=Hook
//
// Cycle 066-extended (2026-06-04) — best-effort rdfs:label set for the
// TomTwinProjects container and each project <id>/ folder.
//
// Spec: F.SetContainerLabel (cosmetic — LaunchPad comma-fix defense-in-depth).
//       Reference_Code_TwinPod-DefaultContainers-quirks.md § FRED-LAUNCHPAD-LABEL-1.
//
// Verifies, against an in-memory pod model (mocked ur.*):
//   - createNewSession() attempts a patchInsert for the TomTwinProjects/ root
//     container ONCE after the first saveIndex() (one-time-per-session guard).
//   - A SECOND createNewSession() does NOT re-attempt the root container label
//     (idempotent guard: _rootContainerLabeled blocks repeat attempts).
//   - saveCurrentSession() attempts a patchInsert for the project's <id>/ folder
//     on the FIRST save (when _sessionMeta has no prior entry for the id).
//   - saveCurrentSession() does NOT re-attempt the project folder label on
//     SUBSEQUENT saves of the same session (already-attempted guard).
//   - patchInsert failure (e.g. 401) is swallowed: saveIndex() still returns
//     successfully and does NOT throw. Save path is unaffected.
//
// Known empirical result (tst-plan.twinpod.eu, 2026-06-03): patchInsert to a
// container slash URL returns 401. These tests verify the HOOK (call is
// attempted with correct args + target URL) and the RESILIENCE (failure does
// not break the save path). Whether the label actually persists on the server
// is an empirical question outside the test scope — documented in the quirks
// file under FRED-LAUNCHPAD-LABEL-1.

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { ref } from 'vue'

const mockHyperFetch = vi.fn()
const mockUploadFile = vi.fn()
const mockPatchInsert = vi.fn()
const mockEnsureContainer = vi.fn().mockResolvedValue(undefined)
const mockEnqueueSave = vi.fn()
const mockDeleteURI = vi.fn().mockResolvedValue(true)
const _saveListeners = new Set()

vi.mock('@kaigilb/twinpod-client', () => ({
  ur: {
    hyperFetch: mockHyperFetch,
    uploadFile: mockUploadFile,
    patchInsert: mockPatchInsert,
    ensureContainer: mockEnsureContainer,
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

const POD_ROOT = 'https://tst-label.example'
const ROOT = `${POD_ROOT}/home/TomTwinProjects`

function jsonResponse(obj, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(obj) }
}
function notFound() {
  return { ok: false, status: 404, text: async () => '' }
}

describe('useSessionIndex — container label-set (Cycle 066-extended)', () => {
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

    // Default: patchInsert succeeds
    mockPatchInsert.mockResolvedValue({ ok: true, status: 201 })
    // Default: index.json reads as 404 (first use)
    mockHyperFetch.mockResolvedValue(notFound())
    // Default: all uploadFile calls succeed
    mockUploadFile.mockResolvedValue({ ok: true, status: 201 })
  })

  afterEach(() => {
    vi.resetModules()
  })

  test('createNewSession attempts patchInsert on root container after first saveIndex()', async () => {
    const { createNewSession, setPodRoot } = useSessionIndex({ document })
    setPodRoot(POD_ROOT)

    await createNewSession()

    // patchInsert should have been called EXACTLY once — for the root container.
    const rootContainerUrl = `${ROOT}/`
    const rootCalls = mockPatchInsert.mock.calls.filter(([url]) => url === rootContainerUrl)
    expect(rootCalls.length).toBe(1)

    // The SPARQL body must contain the rdfs:label predicate URI and "TomTwinProjects".
    const body = rootCalls[0][1]
    expect(body).toContain('http://www.w3.org/2000/01/rdf-schema#label')
    expect(body).toContain('TomTwinProjects')
    expect(body).toContain('INSERT DATA')
  })

  test('second createNewSession does NOT re-attempt root container label (one-time guard)', async () => {
    const { createNewSession, setPodRoot } = useSessionIndex({ document })
    setPodRoot(POD_ROOT)

    await createNewSession()
    const afterFirst = mockPatchInsert.mock.calls.filter(([url]) => url === `${ROOT}/`).length

    await createNewSession()
    const afterSecond = mockPatchInsert.mock.calls.filter(([url]) => url === `${ROOT}/`).length

    expect(afterFirst).toBe(1)
    expect(afterSecond).toBe(1) // No extra call on second createNewSession.
  })

  test('saveCurrentSession attempts patchInsert on project <id>/ folder on first save', async () => {
    const { createNewSession, renameSession, saveCurrentSession, setPodRoot, activeSessionId } = useSessionIndex({ document })
    setPodRoot(POD_ROOT)

    await createNewSession()
    const id = activeSessionId.value

    // Rename so the session has a known display name.
    await renameSession(id, 'My Project')

    mockPatchInsert.mockClear()
    document.value = 'some content'
    await saveCurrentSession('My Project')

    const folderUrl = `${ROOT}/${id}/`
    const folderCalls = mockPatchInsert.mock.calls.filter(([url]) => url === folderUrl)
    expect(folderCalls.length).toBe(1)

    // SPARQL body must contain the rdfs:label predicate URI, the folder URL,
    // and the project display name.
    const body = folderCalls[0][1]
    expect(body).toContain('http://www.w3.org/2000/01/rdf-schema#label')
    expect(body).toContain('My Project')
    expect(body).toContain('INSERT DATA')
  })

  test('saveCurrentSession does NOT re-attempt project folder label on second save', async () => {
    const { createNewSession, saveCurrentSession, setPodRoot, activeSessionId } = useSessionIndex({ document })
    setPodRoot(POD_ROOT)

    await createNewSession()
    const id = activeSessionId.value
    const folderUrl = `${ROOT}/${id}/`

    document.value = 'first edit'
    await saveCurrentSession('My Project')

    mockPatchInsert.mockClear()

    document.value = 'second edit'
    await saveCurrentSession('My Project')

    const folderCalls = mockPatchInsert.mock.calls.filter(([url]) => url === folderUrl)
    expect(folderCalls.length).toBe(0) // No repeat on second save.
  })

  test('patchInsert failure (401) does not throw and does not break save path', async () => {
    // Simulate the known 401 on container slash URL (tst-plan.twinpod.eu, 2026-06-03).
    mockPatchInsert.mockRejectedValue(new Error('PATCH failed: 401'))

    const { createNewSession, saveCurrentSession, setPodRoot, sessionSaveError, activeSessionId } = useSessionIndex({ document })
    setPodRoot(POD_ROOT)

    // Both createNewSession and saveCurrentSession must succeed despite patchInsert throwing.
    await expect(createNewSession()).resolves.not.toThrow()
    expect(sessionSaveError.value).toBeNull()

    document.value = 'content'
    await expect(saveCurrentSession('Test')).resolves.not.toThrow()

    // sessionSaveError must remain null — the label-set failure is suppressed.
    // (sessionSaveError can be set by the content/manifest PUT, but not by patchInsert.)
    // Upload mocks are all ok so no save error.
    expect(sessionSaveError.value).toBeNull()
  })
})
