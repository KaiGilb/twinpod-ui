// UNIT_TYPE=Hook
//
// Cycle 066-extended (2026-06-03) — DEEP self-contained project folder coverage.
//
// Spec: 4Sol.S.TwinPodProjectIndex (self-contained folder + derived catalog) +
//       Cycle 066-extended acceptance criteria 1–5.
//
// Verifies, against an in-memory pod model (mocked ur.*):
//   - Gen-3 READ: a project stored at {root}/<id>/content.json opens.
//   - TRI-GEN read PRECEDENCE: when BOTH a Gen-3 folder and a leftover loose
//     Gen-2 {id}.json exist, the Gen-3 folder wins (read order: folder first).
//   - LAZY-MIGRATE-ON-SAVE: a Gen-2-shaped project (loose {id}.json) that is
//     loaded then saved persists in the Gen-3 shape (content + manifest inside
//     <id>/), with NO write to the legacy container and NO eager bulk move.
//   - INDEX REBUILD-FROM-MANIFESTS: rebuildIndexFromManifests() scans the
//     container, keeps only trailing-slash sub-folders, reads each manifest, and
//     reconstructs catalog entries — proving the manifest (not index.json) is the
//     source of a project's identity. A content.json mis-served as a manifest is
//     rejected by the manifest-shape check (no `blocks`).
//   - NO-REGRESSION: rebuild ignores loose files / index.json at the root.

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { ref } from 'vue'

const mockHyperFetch = vi.fn()
const mockUploadFile = vi.fn()
const mockPatchInsert = vi.fn().mockResolvedValue(undefined)
const mockListContainer = vi.fn()
const mockEnsureContainer = vi.fn().mockResolvedValue(undefined)
const mockEnqueueSave = vi.fn()
const mockDeleteURI = vi.fn().mockResolvedValue(true)
const _saveListeners = new Set()

vi.mock('@kaigilb/twinpod-client', () => ({
  ur: {
    hyperFetch: mockHyperFetch,
    uploadFile: mockUploadFile,
    patchInsert: mockPatchInsert,
    listContainer: mockListContainer,
    ensureContainer: mockEnsureContainer,
    enqueueSave: mockEnqueueSave,
    deleteURI: mockDeleteURI,
    onSaveEvent: vi.fn((fn) => {
      _saveListeners.add(fn)
      return () => _saveListeners.delete(fn)
    })
  }
}))

// In-memory localStorage shim (loadSession's Guard-C restore touches it).
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

const POD_ROOT = 'https://tst-gen3.example/'
const ROOT = 'https://tst-gen3.example/home/TomTwinProjects'
const LEGACY_ROOT = 'https://tst-gen3.example/home/thebrain-sessions'

function jsonResponse(obj, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(obj) }
}
function notFound() {
  return { ok: false, status: 404, text: async () => '' }
}
function contentDoc(id, content, extra = {}) {
  return {
    schemaVersion: 1,
    id,
    name: 'A Project',
    project: 'The Brain',
    created: '2026-06-01T00:00:00.000Z',
    lastModified: '2026-06-01T00:01:00.000Z',
    blocks: [{ id: `${id}-block-1`, kind: 'markdown_text', version: 1, text: content }],
    ...extra
  }
}
function manifestDoc(id, { name = 'A Project', project = 'The Brain' } = {}) {
  return {
    schemaVersion: 1,
    id,
    name,
    project,
    created: '2026-06-01T00:00:00.000Z',
    lastModified: '2026-06-02T00:00:00.000Z',
    owner: null
  }
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
  mockEnsureContainer.mockResolvedValue(undefined)
  mockDeleteURI.mockResolvedValue(true)
  mockUploadFile.mockResolvedValue({ ok: true, status: 200 })
  mockListContainer.mockResolvedValue([])
})
afterEach(() => {
  vi.clearAllMocks()
  _saveListeners.clear()
})

describe('useSessionIndex — Cycle 066-extended DEEP self-contained project folder', () => {

  // Gen-3 READ — content lives at {root}/<id>/content.json.
  // Spec: criterion 4 (Gen-3 read resolves from the self-contained folder).
  test('Gen-3: a project at {root}/<id>/content.json opens', async () => {
    const id = 'gen3-proj-aaaa'
    const CONTENT = 'gen-3 self-contained body'
    mockHyperFetch.mockImplementation(async (url) => {
      if (url === `${ROOT}/${id}/content.json`) return jsonResponse(contentDoc(id, CONTENT))
      return notFound()
    })
    const { useSessionIndex } = await importHook()
    const hook = useSessionIndex({ document: ref('') })
    hook.setPodRoot(POD_ROOT)
    const content = await hook.loadSession(id)
    expect(content).toBe(CONTENT)
  })

  // TRI-GEN read PRECEDENCE — Gen-3 folder wins over a leftover loose Gen-2 file.
  // Spec: criterion 4 (read path resolves Gen-3 → Gen-2 → Gen-1, in that order).
  test('tri-gen precedence: Gen-3 folder content wins over loose Gen-2 {id}.json', async () => {
    const id = 'both-gens-bbbb'
    const GEN3 = 'NEW gen-3 content'
    const GEN2 = 'OLD loose gen-2 content'
    mockHyperFetch.mockImplementation(async (url) => {
      if (url === `${ROOT}/${id}/content.json`) return jsonResponse(contentDoc(id, GEN3))
      if (url === `${ROOT}/${id}.json`) return jsonResponse(contentDoc(id, GEN2))
      return notFound()
    })
    const { useSessionIndex } = await importHook()
    const hook = useSessionIndex({ document: ref('') })
    hook.setPodRoot(POD_ROOT)
    const content = await hook.loadSession(id)
    expect(content).toBe(GEN3) // folder beats loose file
  })

  // Gen-2 READ still works when there is NO Gen-3 folder (no regression).
  // Spec: criterion 4 (Gen-2 loose {id}.json must still open).
  test('Gen-2: loose {id}.json still opens when no Gen-3 folder exists', async () => {
    const id = 'gen2-only-cccc'
    const GEN2 = 'gen-2 loose body'
    mockHyperFetch.mockImplementation(async (url) => {
      if (url === `${ROOT}/${id}/content.json`) return notFound() // no Gen-3 folder
      if (url === `${ROOT}/${id}.json`) return jsonResponse(contentDoc(id, GEN2))
      return notFound()
    })
    const { useSessionIndex } = await importHook()
    const hook = useSessionIndex({ document: ref('') })
    hook.setPodRoot(POD_ROOT)
    const content = await hook.loadSession(id)
    expect(content).toBe(GEN2)
  })

  // LAZY-MIGRATE-ON-SAVE — a Gen-2 project loaded then saved persists Gen-3,
  // leaving the loose file in place (no eager move, no legacy write).
  // Spec: criterion 5 (lazy-migrate-on-save, no bulk move).
  test('lazy-migrate: a Gen-2 project saves into the Gen-3 self-contained shape', async () => {
    const id = 'migrate-me-dddd'
    // Pod starts with a loose Gen-2 file only.
    mockHyperFetch.mockImplementation(async (url) => {
      if (url === `${ROOT}/${id}/content.json`) return notFound()
      if (url === `${ROOT}/${id}.json`) return jsonResponse(contentDoc(id, 'old body'))
      return notFound()
    })
    const { useSessionIndex } = await importHook()
    const docRef = ref('')
    const hook = useSessionIndex({ document: docRef })
    hook.setPodRoot(POD_ROOT)
    hook.sessionList.value = [{ id, name: 'Migrate Me', project: 'The Brain', lastModified: '2026-05-01T00:00:00.000Z' }]

    // Load the Gen-2 project (read falls through to loose {id}.json).
    const loaded = await hook.loadSession(id)
    expect(loaded).toBe('old body')
    hook.activeSessionId.value = id

    // The user edits + the next save persists the Gen-3 shape.
    docRef.value = 'edited body'
    await hook.saveCurrentSession('Migrate Me')

    const putUrls = mockUploadFile.mock.calls.map(([u]) => u)
    expect(putUrls).toContain(`${ROOT}/${id}/content.json`)   // Gen-3 content
    expect(putUrls).toContain(`${ROOT}/${id}/manifest.json`)  // Gen-3 manifest
    // The old loose {id}.json is NOT re-written (left in place, no eager move).
    expect(putUrls).not.toContain(`${ROOT}/${id}.json`)
    // Nothing ever written to the legacy container.
    expect(putUrls.every(u => !u.startsWith(LEGACY_ROOT))).toBe(true)
  })

  // INDEX REBUILD-FROM-MANIFESTS — reconstruct entries by scanning folders'
  // manifests. Proves index.json is a derived catalog, manifest is identity.
  // Spec: criterion 2 (rebuild index.json by scanning manifests).
  test('rebuildIndexFromManifests reconstructs entries from the folders\' manifests', async () => {
    const idA = 'rebuild-a-1111'
    const idB = 'rebuild-b-2222'
    // listContainer returns sub-folders (trailing slash) AND loose files (no slash)
    // AND index.json — only the folders must be scanned for a manifest.
    mockListContainer.mockResolvedValue([
      `${ROOT}/${idA}/`,
      `${ROOT}/${idB}/`,
      `${ROOT}/some-loose-gen2.json`, // a leftover loose Gen-2 file — must be ignored
      `${ROOT}/index.json`            // the catalog itself — must be ignored
    ])
    mockHyperFetch.mockImplementation(async (url) => {
      if (url === `${ROOT}/${idA}/manifest.json`) return jsonResponse(manifestDoc(idA, { name: 'Alpha', project: 'NoteWorld' }))
      if (url === `${ROOT}/${idB}/manifest.json`) return jsonResponse(manifestDoc(idB, { name: 'Beta', project: 'The Brain' }))
      return notFound()
    })
    const { useSessionIndex } = await importHook()
    const hook = useSessionIndex({ document: ref('') })
    hook.setPodRoot(POD_ROOT)

    const entries = await hook.rebuildIndexFromManifests()
    const byId = Object.fromEntries(entries.map(e => [e.id, e]))

    expect(entries).toHaveLength(2)
    expect(byId[idA]).toMatchObject({ id: idA, name: 'Alpha', project: 'NoteWorld' })
    expect(byId[idB]).toMatchObject({ id: idB, name: 'Beta', project: 'The Brain' })
    // Reconstructed entry shape matches the index.json catalog entry shape.
    expect(typeof byId[idA].lastModified).toBe('string')
    // listContainer was queried against the projects root with a trailing slash.
    expect(mockListContainer).toHaveBeenCalledWith(`${ROOT}/`)
  })

  // REBUILD shape-rejection — a folder whose manifest.json slot returns a CONTENT
  // doc (has `blocks`) under the TwinPod 200-not-404 quirk is NOT treated as a
  // manifest. Prevents a fabricated 200 / content doc from polluting the catalog.
  // Spec: criterion 2 + TwinPod 200-not-404 shape-primary detection.
  test('rebuild rejects a non-manifest body (content doc with blocks) at the manifest slot', async () => {
    const idGood = 'good-3333'
    const idBad = 'bad-4444'
    mockListContainer.mockResolvedValue([`${ROOT}/${idGood}/`, `${ROOT}/${idBad}/`])
    mockHyperFetch.mockImplementation(async (url) => {
      if (url === `${ROOT}/${idGood}/manifest.json`) return jsonResponse(manifestDoc(idGood, { name: 'Good' }))
      // Bad folder: the manifest slot returns a CONTENT doc (has blocks) — reject.
      if (url === `${ROOT}/${idBad}/manifest.json`) return jsonResponse(contentDoc(idBad, 'oops content here'))
      return notFound()
    })
    const { useSessionIndex } = await importHook()
    const hook = useSessionIndex({ document: ref('') })
    hook.setPodRoot(POD_ROOT)

    const entries = await hook.rebuildIndexFromManifests()
    const ids = entries.map(e => e.id)
    expect(ids).toContain(idGood)
    expect(ids).not.toContain(idBad) // content doc rejected by manifest-shape check
  })

  // REBUILD on an empty / missing container returns [] (no throw).
  test('rebuildIndexFromManifests returns [] when the container is empty', async () => {
    mockListContainer.mockResolvedValue([])
    const { useSessionIndex } = await importHook()
    const hook = useSessionIndex({ document: ref('') })
    hook.setPodRoot(POD_ROOT)
    expect(await hook.rebuildIndexFromManifests()).toEqual([])
  })

  // RENAME syncs the in-folder manifest for an ALREADY-MIGRATED (Gen-3) project,
  // so the portable folder carries the new name even without a content re-edit.
  // Spec: criterion 1 (manifest is the source of truth for identity).
  test('renameSession re-writes manifest.json for a migrated (Gen-3) project', async () => {
    const id = 'rename-gen3-6666'
    // content.json exists → migrated. (probe for migration returns a content doc.)
    mockHyperFetch.mockImplementation(async (url) => {
      if (url === `${ROOT}/${id}/content.json`) return jsonResponse(contentDoc(id, 'body'))
      return notFound()
    })
    const { useSessionIndex } = await importHook()
    const hook = useSessionIndex({ document: ref('') })
    hook.setPodRoot(POD_ROOT)
    hook.sessionList.value = [{ id, name: 'Old Name', project: 'The Brain', lastModified: '2026-06-01T00:00:00.000Z' }]

    await hook.renameSession(id, 'New Name')

    const manifestCall = mockUploadFile.mock.calls.find(([u]) => u === `${ROOT}/${id}/manifest.json`)
    expect(manifestCall).toBeTruthy()
    const written = JSON.parse(manifestCall[1])
    expect(written.name).toBe('New Name')
    // `created` is PRESERVED from the content doc, NOT regenerated to now(). This
    // project was renamed-from-list without being opened (so _sessionMeta is empty
    // and entry.lastModified was just set to now() by the optimistic update); the
    // sync must read created from content.json (2026-06-01) — a regression here would
    // silently corrupt the field this cycle declares authoritative.
    expect(written.created).toBe('2026-06-01T00:00:00.000Z')
    // index.json is also written (derived catalog).
    expect(mockUploadFile.mock.calls.some(([u]) => u === `${ROOT}/index.json`)).toBe(true)
  })

  // RENAME does NOT write a manifest for an UN-MIGRATED Gen-2 project (no folder yet)
  // — its next content-save migrates it with the correct name (lazy-migrate).
  // Spec: criterion 5 (no eager folder materialisation on a rename).
  test('renameSession does NOT write manifest.json for an un-migrated (Gen-2) project', async () => {
    const id = 'rename-gen2-7777'
    // content.json 404 → not migrated.
    mockHyperFetch.mockImplementation(async () => notFound())
    const { useSessionIndex } = await importHook()
    const hook = useSessionIndex({ document: ref('') })
    hook.setPodRoot(POD_ROOT)
    hook.sessionList.value = [{ id, name: 'Old Name', project: 'The Brain', lastModified: '2026-06-01T00:00:00.000Z' }]

    await hook.renameSession(id, 'New Name')

    const manifestWritten = mockUploadFile.mock.calls.some(([u]) => u === `${ROOT}/${id}/manifest.json`)
    expect(manifestWritten).toBe(false)
    // index.json IS still written (the live UI rename is captured there).
    expect(mockUploadFile.mock.calls.some(([u]) => u === `${ROOT}/index.json`)).toBe(true)
  })

  // RENAME-PROJECT (grouping label) also syncs the manifest's `project` for a
  // migrated project — the rebuild reconstructs `project` from the manifest.
  // Spec: criterion 2 (rebuild reads project from the manifest).
  test('renameSessionProject re-writes manifest.json project for a migrated project', async () => {
    const id = 'regroup-gen3-8888'
    mockHyperFetch.mockImplementation(async (url) => {
      if (url === `${ROOT}/${id}/content.json`) return jsonResponse(contentDoc(id, 'body'))
      return notFound()
    })
    const { useSessionIndex } = await importHook()
    const hook = useSessionIndex({ document: ref('') })
    hook.setPodRoot(POD_ROOT)
    hook.sessionList.value = [{ id, name: 'P', project: 'The Brain', lastModified: '2026-06-01T00:00:00.000Z' }]

    await hook.renameSessionProject(id, 'NoteWorld')

    const manifestCall = mockUploadFile.mock.calls.find(([u]) => u === `${ROOT}/${id}/manifest.json`)
    expect(manifestCall).toBeTruthy()
    expect(JSON.parse(manifestCall[1]).project).toBe('NoteWorld')
  })
})
