// UNIT_TYPE=Hook
//
// Cycle 067 P0 REGRESSION — login-clobber + self-healing catalog recovery.
//
// Background: Step A (twinpod-ui d6018f7) made createNewSession() persist a new
// project IMMEDIATELY (folder + manifest.json + content.json + index.json) via
// saveCurrentSession(). The P0 symptom Kai verified on tst-jack: on login, ALL
// previously-saved projects were missing from the list.
//
// Root-cause family this file pins down with executable tests:
//   (A) WRITE/CLOBBER: an auto-create (App.vue Layer 1) firing while sessionList
//       is still its boot-time empty [] (loadIndex not yet complete) mints a
//       project and writes index.json = [one empty entry], overwriting the real
//       catalog. createNewSession ALWAYS wrote index.json — both before and after
//       Step A — so the clobber is a function of WHEN it runs, not Step A's diff.
//   (B) READ regression: index.json present but loadIndex returns empty.
//
// Both fixes verified here are correct under (A) AND (B):
//   3a  loadIndex sets indexLoaded only after sessionList holds the authoritative
//       (possibly rebuilt) catalog. App.vue's auto-create watcher gates on this
//       flag, so auto-create cannot run against an unhydrated list. (The flag
//       contract is what App.vue depends on; verified at the package boundary.)
//   3b  loadIndex SELF-HEALS: when the merged catalog is empty but per-project
//       Gen-3 folders with manifests exist, it rebuilds the list from the
//       manifests (Cycle-066 rebuildable-catalog guarantee) — so tst-jack's list
//       recovers on next login regardless of how index.json was emptied, with NO
//       data loss.
//
// Spec: 4Sol.S.TwinPodProjectIndex (derived catalog, rebuildable from manifests),
//       3P.F.SessionList, 3P.F.SessionCreate.

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { ref } from 'vue'

const mockHyperFetch = vi.fn()
const mockUploadFile = vi.fn()
const mockListContainer = vi.fn()
const mockEnqueueSave = vi.fn()
const mockDeleteURI = vi.fn().mockResolvedValue(true)
const _saveListeners = new Set()

vi.mock('@kaigilb/twinpod-client', () => ({
  ur: {
    hyperFetch: mockHyperFetch,
    uploadFile: mockUploadFile,
    listContainer: mockListContainer,
    enqueueSave: mockEnqueueSave,
    deleteURI: mockDeleteURI,
    onSaveEvent: vi.fn((fn) => {
      _saveListeners.add(fn)
      return () => _saveListeners.delete(fn)
    })
  }
}))

// In-memory localStorage shim (some boot paths touch it).
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

const POD_ROOT = 'https://tst-jack.example/'
const ROOT = 'https://tst-jack.example/home/TomTwinProjects'

function jsonResponse(obj, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(obj) }
}
function notFound() {
  return { ok: false, status: 404, text: async () => '' }
}
function manifestDoc(id, { name = 'A Project', project = 'The Brain' } = {}) {
  return {
    schemaVersion: 1,
    id,
    name,
    project,
    created: '2026-05-01T00:00:00.000Z',
    lastModified: '2026-05-02T00:00:00.000Z',
    owner: null
  }
}
function indexEntry(id, name) {
  return { id, name, project: 'The Brain', lastModified: '2026-05-03T00:00:00.000Z' }
}

async function importHook() {
  const mod = await import('./useSessionIndex.js')
  mod._resetModuleStateForTesting()
  return mod
}

beforeEach(() => {
  vi.clearAllMocks()
  _saveListeners.clear()
  _store.clear()
  mockDeleteURI.mockResolvedValue(true)
  mockUploadFile.mockResolvedValue({ ok: true, status: 200 })
  mockListContainer.mockResolvedValue([])
})
afterEach(() => {
  vi.clearAllMocks()
  _saveListeners.clear()
})

describe('useSessionIndex — Cycle 067 P0 login-clobber + self-healing recovery', () => {

  // EXISTING USER, intact index → full list loads, indexLoaded flips true, and
  // nothing is written (no spurious empty-session create, no index.json clobber).
  // This is the primary regression: a returning tst-jack user must see ALL their
  // projects after login.
  test('existing user: full list loads from index.json, index not clobbered, indexLoaded true', async () => {
    const list = [indexEntry('proj-aaaa', 'Alpha'), indexEntry('proj-bbbb', 'Beta'), indexEntry('proj-cccc', 'Gamma')]
    mockHyperFetch.mockImplementation(async (url) => {
      if (url === `${ROOT}/index.json`) return jsonResponse(list)
      return notFound()
    })
    const { useSessionIndex } = await importHook()
    const hook = useSessionIndex({ document: ref('') })
    hook.setPodRoot(POD_ROOT)

    expect(hook.indexLoaded.value).toBe(false) // not loaded before loadIndex runs

    await hook.loadIndex()

    // Full catalog hydrated.
    expect(hook.sessionList.value.map(s => s.id)).toEqual(['proj-aaaa', 'proj-bbbb', 'proj-cccc'])
    // Load completed → auto-create is now permitted (App.vue gates on this flag).
    expect(hook.indexLoaded.value).toBe(true)
    // No write happened during a pure read/login — index.json was NOT clobbered.
    expect(mockUploadFile).not.toHaveBeenCalled()
  })

  // SELF-HEALING (3b, criterion 2): index.json MISSING (404) but per-project
  // Gen-3 folders with manifests exist → loadIndex rebuilds the list from the
  // manifests. This is the recovery path for a clobbered/lost index — tst-jack's
  // projects come back on next login with no data loss.
  test('index.json missing but folders present → list rebuilt from manifests', async () => {
    mockListContainer.mockResolvedValue([
      `${ROOT}/proj-aaaa/`,
      `${ROOT}/proj-bbbb/`,
      `${ROOT}/index.json`,            // catalog itself — ignored by rebuild
      `${ROOT}/some-loose.json`        // loose file — ignored by rebuild
    ])
    mockHyperFetch.mockImplementation(async (url) => {
      if (url === `${ROOT}/index.json`) return notFound() // index gone
      if (url === `${ROOT}/proj-aaaa/manifest.json`) return jsonResponse(manifestDoc('proj-aaaa', { name: 'Alpha' }))
      if (url === `${ROOT}/proj-bbbb/manifest.json`) return jsonResponse(manifestDoc('proj-bbbb', { name: 'Beta' }))
      return notFound()
    })
    const { useSessionIndex } = await importHook()
    const hook = useSessionIndex({ document: ref('') })
    hook.setPodRoot(POD_ROOT)

    await hook.loadIndex()

    const ids = hook.sessionList.value.map(s => s.id).sort()
    expect(ids).toEqual(['proj-aaaa', 'proj-bbbb'])
    const byId = Object.fromEntries(hook.sessionList.value.map(e => [e.id, e]))
    expect(byId['proj-aaaa'].name).toBe('Alpha')
    expect(byId['proj-bbbb'].name).toBe('Beta')
    // Recovery is read-only here — loadIndex does NOT write index.json itself.
    expect(mockUploadFile).not.toHaveBeenCalled()
    expect(hook.indexLoaded.value).toBe(true)
  })

  // SELF-HEALING when index.json is present but an EMPTY array (the exact clobber
  // signature — a single auto-create that wrote []- or near-empty index) yet the
  // real per-project folders survive. loadIndex must recover the full list from
  // the manifests, NOT trust the empty catalog.
  test('index.json is an empty array but folders present → list rebuilt (clobber recovery)', async () => {
    mockListContainer.mockResolvedValue([`${ROOT}/proj-aaaa/`, `${ROOT}/proj-bbbb/`])
    mockHyperFetch.mockImplementation(async (url) => {
      if (url === `${ROOT}/index.json`) return jsonResponse([]) // clobbered to empty
      if (url === `${ROOT}/proj-aaaa/manifest.json`) return jsonResponse(manifestDoc('proj-aaaa', { name: 'Alpha' }))
      if (url === `${ROOT}/proj-bbbb/manifest.json`) return jsonResponse(manifestDoc('proj-bbbb', { name: 'Beta' }))
      return notFound()
    })
    const { useSessionIndex } = await importHook()
    const hook = useSessionIndex({ document: ref('') })
    hook.setPodRoot(POD_ROOT)

    await hook.loadIndex()

    expect(hook.sessionList.value.map(s => s.id).sort()).toEqual(['proj-aaaa', 'proj-bbbb'])
  })

  // PARTIAL CLOBBER (the realistic tst-jack state, 3b "partial" case): the clobber
  // writes a ONE-entry index.json (createNewSession appended to an empty list), but
  // the user's N real project folders survive untouched. loadIndex must UNION the
  // surviving manifests into the catalog on next login so the full list recovers —
  // recovery cannot be gated on "merged is empty", because a 1-entry index is NOT
  // empty. This is the case that actually restores tst-jack on next login.
  test('partial clobber: index.json has 1 spurious entry but N real folders survive → full list recovered on login', async () => {
    mockListContainer.mockResolvedValue([
      `${ROOT}/spurious-new/`, `${ROOT}/proj-aaaa/`, `${ROOT}/proj-bbbb/`, `${ROOT}/proj-cccc/`,
      `${ROOT}/index.json`
    ])
    mockHyperFetch.mockImplementation(async (url) => {
      // The clobbered index lists ONLY the spurious empty project.
      if (url === `${ROOT}/index.json`) return jsonResponse([indexEntry('spurious-new', 'Project (empty)')])
      if (url === `${ROOT}/spurious-new/manifest.json`) return jsonResponse(manifestDoc('spurious-new', { name: 'Project (empty)' }))
      if (url === `${ROOT}/proj-aaaa/manifest.json`) return jsonResponse(manifestDoc('proj-aaaa', { name: 'Alpha' }))
      if (url === `${ROOT}/proj-bbbb/manifest.json`) return jsonResponse(manifestDoc('proj-bbbb', { name: 'Beta' }))
      if (url === `${ROOT}/proj-cccc/manifest.json`) return jsonResponse(manifestDoc('proj-cccc', { name: 'Gamma' }))
      return notFound()
    })
    const { useSessionIndex } = await importHook()
    const hook = useSessionIndex({ document: ref('') })
    hook.setPodRoot(POD_ROOT)

    await hook.loadIndex()

    // All FOUR survive — the 3 real projects unioned in from their manifests,
    // plus the spurious one (harmless; the user can delete it). tst-jack's real
    // projects are back on next login.
    const ids = hook.sessionList.value.map(s => s.id).sort()
    expect(ids).toEqual(['proj-aaaa', 'proj-bbbb', 'proj-cccc', 'spurious-new'])
    expect(hook.indexLoaded.value).toBe(true)
  })

  // UNION must NOT shrink or override a correctly-loaded catalog: when index.json
  // already lists projects, an existing index entry WINS over the manifest for the
  // same id (the index carries the live name/lastModified); only manifest-only ids
  // are added. So a healthy login is unchanged except for additive recovery.
  test('union: existing index entry wins over manifest for the same id; only manifest-only ids are added', async () => {
    mockListContainer.mockResolvedValue([`${ROOT}/proj-aaaa/`, `${ROOT}/orphan-bbbb/`])
    mockHyperFetch.mockImplementation(async (url) => {
      // index.json has proj-aaaa with a FRESH name; orphan-bbbb is index-missing.
      if (url === `${ROOT}/index.json`) return jsonResponse([{ id: 'proj-aaaa', name: 'Alpha (fresh)', project: 'The Brain', lastModified: '2026-06-01T00:00:00.000Z' }])
      if (url === `${ROOT}/proj-aaaa/manifest.json`) return jsonResponse(manifestDoc('proj-aaaa', { name: 'Alpha (stale manifest)' }))
      if (url === `${ROOT}/orphan-bbbb/manifest.json`) return jsonResponse(manifestDoc('orphan-bbbb', { name: 'Orphan' }))
      return notFound()
    })
    const { useSessionIndex } = await importHook()
    const hook = useSessionIndex({ document: ref('') })
    hook.setPodRoot(POD_ROOT)

    await hook.loadIndex()

    const byId = Object.fromEntries(hook.sessionList.value.map(e => [e.id, e]))
    // Index entry wins for proj-aaaa (live name preserved, not overwritten by manifest).
    expect(byId['proj-aaaa'].name).toBe('Alpha (fresh)')
    // Manifest-only orphan is recovered (additive).
    expect(byId['orphan-bbbb'].name).toBe('Orphan')
    expect(hook.sessionList.value).toHaveLength(2)
  })

  // GENUINELY NEW USER: no index.json, no folders → empty list, NO fabricated
  // entries, indexLoaded true (so the FIRST real "+ New Project" / type-to-create
  // is permitted). Proves the self-heal does not invent projects.
  test('genuinely new user: empty index, no folders → empty list, no fabrication, indexLoaded true', async () => {
    mockHyperFetch.mockImplementation(async () => notFound())
    mockListContainer.mockResolvedValue([])
    const { useSessionIndex } = await importHook()
    const hook = useSessionIndex({ document: ref('') })
    hook.setPodRoot(POD_ROOT)

    await hook.loadIndex()

    expect(hook.sessionList.value).toEqual([])
    expect(hook.indexLoaded.value).toBe(true)
    expect(mockUploadFile).not.toHaveBeenCalled()
  })

  // CAUSATION PROOF — the clobber mechanism, demonstrated directly.
  //
  // This is what the P0 was: createNewSession() appends to sessionList and then
  // (inside saveCurrentSession) writes index.json = JSON.stringify(sessionList).
  // If sessionList is still the boot-time empty [] (loadIndex not yet run), the
  // index.json PUT body is a SINGLE-entry array — overwriting the user's real
  // catalog. We assert this is exactly what happens when createNewSession runs
  // against an unhydrated list, which is why App.vue must gate auto-create on
  // indexLoaded (the fix) rather than letting it fire during the load window.
  //
  // NOTE: createNewSession ALWAYS wrote index.json from sessionList (both before
  // and after Step A d6018f7 — Step A only ADDED the manifest/content writes).
  // So the clobber is a function of WHEN create runs, not of Step A's diff — which
  // is why a bare source-revert of Step A does NOT make this go away, and why the
  // durable fix is the indexLoaded gate + self-healing rebuild, not a revert.
  test('causation: createNewSession against an unhydrated empty list writes a single-entry index.json (the clobber)', async () => {
    mockHyperFetch.mockImplementation(async () => notFound())
    mockUploadFile.mockResolvedValue({ ok: true, status: 200 })

    const { useSessionIndex } = await importHook()
    const hook = useSessionIndex({ document: ref('') })
    hook.setPodRoot(POD_ROOT)

    // Simulate the bug window: loadIndex has NOT run, so sessionList is empty []
    // even though the pod holds a real catalog. An auto-create fires here.
    expect(hook.sessionList.value).toEqual([])
    expect(hook.indexLoaded.value).toBe(false)

    await hook.createNewSession()

    // index.json was overwritten with ONLY the freshly-minted project — the real
    // catalog (had it been loaded) would have been clobbered. This is the harm the
    // indexLoaded gate (App.vue) prevents by never letting auto-create reach here
    // before loadIndex hydrates sessionList.
    const indexPut = mockUploadFile.mock.calls.find(([u]) => u === `${ROOT}/index.json`)
    expect(indexPut).toBeTruthy()
    const writtenCatalog = JSON.parse(indexPut[1])
    expect(writtenCatalog).toHaveLength(1) // single entry = the clobber signature
  })

  // REAL LOAD ERROR (5xx) must NOT flip indexLoaded — leaving it false keeps
  // App.vue's auto-create guard closed, so a transient read failure cannot lead
  // to an auto-create that clobbers a catalog that merely failed to read.
  test('real load error (5xx) leaves indexLoaded false (auto-create stays blocked)', async () => {
    mockHyperFetch.mockImplementation(async (url) => {
      if (url === `${ROOT}/index.json`) return { ok: false, status: 503, text: async () => 'err' }
      return notFound()
    })
    mockListContainer.mockResolvedValue([])
    const { useSessionIndex } = await importHook()
    const hook = useSessionIndex({ document: ref('') })
    hook.setPodRoot(POD_ROOT)

    await hook.loadIndex()

    expect(hook.indexLoadError.value).toBeTruthy()
    expect(hook.indexLoaded.value).toBe(false)
    expect(hook.sessionList.value).toEqual([])
  })
})
