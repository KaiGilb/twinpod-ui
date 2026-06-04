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

  // IMMEDIATE PERSIST (Cycle 067, 2026-06-04) — createNewSession now writes the
  // project's folder + manifest.json + content.json + index.json to the pod on
  // create, with no user action and no navigation trick required. The three pod
  // files appear synchronously with the create call.
  //
  // (This supersedes the Cycle 066-extended "createNewSession is fresh, no
  // content.json until first save" behaviour: the immediate save IS the first
  // save, so the session is no longer fresh after create and a follow-up rename
  // legitimately probes content.json — see the next test.)
  test('createNewSession writes folder + manifest.json + content.json + index.json immediately', async () => {
    mockHyperFetch.mockImplementation(async (url) => {
      if (url.endsWith('/index.json')) return notFound()
      return notFound()
    })
    mockUploadFile.mockResolvedValue({ ok: true, status: 200 })

    const { useSessionIndex } = await importHook()
    const docRef = ref('')
    const hook = useSessionIndex({ document: docRef })
    hook.setPodRoot(POD_ROOT)

    await hook.createNewSession()
    const id = hook.activeSessionId.value
    expect(id).toBeTruthy()

    const putUrls = mockUploadFile.mock.calls.map(([u]) => u)
    expect(putUrls).toContain(`${ROOT}/${id}/manifest.json`) // identity metadata
    expect(putUrls).toContain(`${ROOT}/${id}/content.json`)  // editable content
    expect(putUrls).toContain(`${ROOT}/index.json`)          // derived catalog

    // The seeded document shows the project name at the top as a `# <name>` heading.
    expect(docRef.value.startsWith('# ')).toBe(true)
    const contentCall = mockUploadFile.mock.calls.find(([u]) => u === `${ROOT}/${id}/content.json`)
    const contentDocBody = JSON.parse(contentCall[1])
    expect(contentDocBody.blocks[0].text).toBe(docRef.value)
  })

  // An explicit name passed to createNewSession({ name }) lands in the SINGLE
  // create-time write — no separate rename, no transient stale heading.
  test('createNewSession({ name }) seeds the given name and writes it in one shot', async () => {
    mockHyperFetch.mockImplementation(async (url) => {
      if (url.endsWith('/index.json')) return notFound()
      return notFound()
    })
    mockUploadFile.mockResolvedValue({ ok: true, status: 200 })

    const { useSessionIndex } = await importHook()
    const docRef = ref('')
    const hook = useSessionIndex({ document: docRef })
    hook.setPodRoot(POD_ROOT)

    await hook.createNewSession({ name: 'My Cool Project' })
    const id = hook.activeSessionId.value

    expect(docRef.value.startsWith('# My Cool Project')).toBe(true)
    const manifestCall = mockUploadFile.mock.calls.find(([u]) => u === `${ROOT}/${id}/manifest.json`)
    expect(JSON.parse(manifestCall[1]).name).toBe('My Cool Project')
  })

  // After the immediate create-save, the session is migrated (content.json exists)
  // so a follow-up rename probes content.json — the standard Gen-3 sync path — and
  // re-writes the manifest with the new name (criterion 1: manifest is identity).
  test('renameSession after immediate-create probes content.json and updates the manifest', async () => {
    const { useSessionIndex } = await importHook()
    const docRef = ref('')
    const hook = useSessionIndex({ document: docRef })
    hook.setPodRoot(POD_ROOT)

    mockHyperFetch.mockImplementation(async (url) => {
      if (url.endsWith('/index.json')) return notFound()
      return notFound()
    })
    mockUploadFile.mockResolvedValue({ ok: true, status: 200 })

    await hook.createNewSession()
    const id = hook.activeSessionId.value
    expect(id).toBeTruthy()

    // content.json now exists on the pod — the rename probe should hit it.
    mockHyperFetch.mockImplementation(async (url) => {
      if (url === `${ROOT}/${id}/content.json`) return jsonResponse(contentDoc(id, 'seeded'))
      return notFound()
    })
    vi.clearAllMocks()
    mockUploadFile.mockResolvedValue({ ok: true, status: 200 })
    mockHyperFetch.mockImplementation(async (url) => {
      if (url === `${ROOT}/${id}/content.json`) return jsonResponse(contentDoc(id, 'seeded'))
      return notFound()
    })

    await hook.renameSession(id, 'Renamed Project')

    const contentJsonProbes = mockHyperFetch.mock.calls
      .filter(([u]) => u === `${ROOT}/${id}/content.json`)
    expect(contentJsonProbes.length).toBeGreaterThan(0)
    const manifestCall = mockUploadFile.mock.calls.find(([u]) => u === `${ROOT}/${id}/manifest.json`)
    expect(manifestCall).toBeTruthy()
    expect(JSON.parse(manifestCall[1]).name).toBe('Renamed Project')
    // index.json IS written (live UI rename captured in the catalog).
    expect(mockUploadFile.mock.calls.some(([u]) => u === `${ROOT}/index.json`)).toBe(true)
  })

  // RENAME-SAFETY (Cycle 067 criterion 3): renaming the OPEN project rewrites the
  // seeded `# <oldName>` heading in place — no stale line, no duplicate line.
  test('renameSession rewrites the seeded heading of the open project in place', async () => {
    mockHyperFetch.mockImplementation(async () => notFound())
    mockUploadFile.mockResolvedValue({ ok: true, status: 200 })

    const { useSessionIndex } = await importHook()
    const docRef = ref('')
    const hook = useSessionIndex({ document: docRef })
    hook.setPodRoot(POD_ROOT)

    await hook.createNewSession({ name: 'First Name' })
    const id = hook.activeSessionId.value
    expect(docRef.value.startsWith('# First Name')).toBe(true)

    await hook.renameSession(id, 'Second Name')

    // Heading updated in place; exactly ONE name line (no duplicate).
    expect(docRef.value.startsWith('# Second Name')).toBe(true)
    expect(docRef.value).not.toContain('# First Name')
    const headingLines = docRef.value.split('\n').filter(l => l.startsWith('# '))
    expect(headingLines).toHaveLength(1)
  })

  // RENAME-SAFETY: if the user EDITED the heading, rename leaves the body alone —
  // never appends a second name line.
  test('renameSession does NOT touch the body when the seeded heading was edited', async () => {
    mockHyperFetch.mockImplementation(async () => notFound())
    mockUploadFile.mockResolvedValue({ ok: true, status: 200 })

    const { useSessionIndex } = await importHook()
    const docRef = ref('')
    const hook = useSessionIndex({ document: docRef })
    hook.setPodRoot(POD_ROOT)

    await hook.createNewSession({ name: 'Seeded' })
    const id = hook.activeSessionId.value

    // User rewrites the heading to their own text.
    const userEdited = '# My own title\n\nsome notes'
    docRef.value = userEdited

    await hook.renameSession(id, 'New Catalog Name')

    // Body untouched — no duplicate name line injected.
    expect(docRef.value).toBe(userEdited)
  })

  // After the first saveCurrentSession(), the session is no longer "fresh" —
  // a subsequent rename DOES probe content.json (the standard Gen-3 sync path).
  // This ensures _freshSessions.delete(id) inside saveCurrentSession() works.
  test('renameSession probes content.json after the first saveCurrentSession()', async () => {
    mockUploadFile.mockResolvedValue({ ok: true, status: 200 })
    // content.json will be present after save — simulate a hit on the probe.
    const CONTENT = 'first saved content'
    mockHyperFetch.mockImplementation(async (url) => {
      if (url.endsWith('/index.json')) return notFound()
      return notFound()
    })

    const { useSessionIndex } = await importHook()
    const docRef = ref('')
    const hook = useSessionIndex({ document: docRef })
    hook.setPodRoot(POD_ROOT)

    await hook.createNewSession()
    const id = hook.activeSessionId.value
    expect(id).toBeTruthy()

    // First save — this clears the id from _freshSessions.
    docRef.value = CONTENT
    hook.sessionList.value = [{ id, name: 'Temp Name', project: 'The Brain', lastModified: new Date().toISOString() }]
    await hook.saveCurrentSession('Temp Name')

    // Now the probe for the NEXT rename should fire: update the hyperFetch mock
    // to return the content doc (content.json now exists on the pod).
    mockHyperFetch.mockImplementation(async (url) => {
      if (url === `${ROOT}/${id}/content.json`) return jsonResponse(contentDoc(id, CONTENT))
      return notFound()
    })
    vi.clearAllMocks()
    mockUploadFile.mockResolvedValue({ ok: true, status: 200 })
    mockHyperFetch.mockImplementation(async (url) => {
      if (url === `${ROOT}/${id}/content.json`) return jsonResponse(contentDoc(id, CONTENT))
      return notFound()
    })

    await hook.renameSession(id, 'Renamed After Save')

    // The probe DID fire — content.json was queried to check migration.
    const contentJsonProbes = mockHyperFetch.mock.calls
      .filter(([u]) => u === `${ROOT}/${id}/content.json`)
    expect(contentJsonProbes.length).toBeGreaterThan(0)
    // Manifest was written (project was Gen-3 migrated by the save above).
    const manifestCall = mockUploadFile.mock.calls.find(([u]) => u === `${ROOT}/${id}/manifest.json`)
    expect(manifestCall).toBeTruthy()
    expect(JSON.parse(manifestCall[1]).name).toBe('Renamed After Save')
  })

  // ───────────────────────────────────────────────────────────────────────────
  // _ensureContainer tests (Cycle 066-extended rev4, 2026-06-04)
  //
  // These tests cover the HEAD-first container pre-creation guard introduced to
  // fix 409 on strict-LDP pods (tst-planlegger, tst-solveig). All four cases
  // use a mock sessionFetch (the function wired by setSessionFetch in App.vue)
  // rather than ur.* — _ensureContainer deliberately does NOT route through
  // ur.uploadFile because that sends JSON headers unsuitable for a container PUT.
  // ───────────────────────────────────────────────────────────────────────────

  // HEAD-404 → PUT fires: when the container does not exist, ensureContainer issues
  // a HEAD (→ 404) and then a PUT with the BasicContainer Link header.
  test('_ensureContainer: HEAD-404 → PUT is issued to create the container', async () => {
    const id = 'ensure-head404-aaaa'
    mockHyperFetch.mockImplementation(async () => notFound())
    mockUploadFile.mockResolvedValue({ ok: true, status: 200 })

    const mockSessionFetch = vi.fn().mockImplementation(async (url, opts) => {
      if (opts?.method === 'HEAD') return { ok: false, status: 404 }
      if (opts?.method === 'PUT') return { ok: true, status: 201 }
      return { ok: false, status: 404 }
    })

    const { useSessionIndex } = await importHook()
    const docRef = ref('content')
    const hook = useSessionIndex({ document: docRef })
    hook.setPodRoot(POD_ROOT)
    hook.setSessionFetch(mockSessionFetch)
    hook.activeSessionId.value = id
    hook.sessionList.value = [{ id, name: 'Test', project: 'The Brain', lastModified: new Date().toISOString() }]

    await hook.saveCurrentSession('Test')

    // At least one PUT was issued via sessionFetch (not uploadFile) for container creation.
    const putCalls = mockSessionFetch.mock.calls.filter(([, opts]) => opts?.method === 'PUT')
    expect(putCalls.length).toBeGreaterThan(0)
    // HEAD was issued first.
    const headCalls = mockSessionFetch.mock.calls.filter(([, opts]) => opts?.method === 'HEAD')
    expect(headCalls.length).toBeGreaterThan(0)

    // AUTHORITATIVE captured-wire recipe (AcceleratorWireMap 2026-06-03): every
    // container-creation PUT carries the rdfs:label body (NOT empty) and NO Slug header.
    for (const [, opts] of putCalls) {
      expect(opts.headers['Content-Type']).toBe('text/turtle')
      expect(opts.headers).not.toHaveProperty('Slug')
      expect(opts.body).toMatch(/<>\s+rdfs:label\s+"[^"]+"\s*\./)
    }
  })

  // AUTHORITATIVE captured-wire recipe assertions (AcceleratorWireMap 2026-06-03):
  //   - parent TomTwinProjects/ container PUT body = `<> rdfs:label "TomTwinProjects" .`
  //   - project <id>/ container PUT body = `<> rdfs:label "<display-name>" .`  (the
  //     friendly NAME, not the id slug — the path stays the stable id)
  //   - both: Content-Type text/turtle, trailing slash on the URL, NO Slug header.
  test('_ensureContainer: PUT body carries rdfs:label = clean name for parent and project folder (no Slug, trailing slash)', async () => {
    const id = 'sanskrit-zzzz'
    const displayName = 'Sanskrit'
    mockHyperFetch.mockImplementation(async () => notFound())
    mockUploadFile.mockResolvedValue({ ok: true, status: 200 })

    const mockSessionFetch = vi.fn().mockImplementation(async (url, opts) => {
      if (opts?.method === 'HEAD') return { ok: false, status: 404 }
      if (opts?.method === 'PUT') return { ok: true, status: 200 }
      return { ok: false, status: 404 }
    })

    const { useSessionIndex } = await importHook()
    const docRef = ref('content')
    const hook = useSessionIndex({ document: docRef })
    hook.setPodRoot(POD_ROOT)
    hook.setSessionFetch(mockSessionFetch)
    hook.activeSessionId.value = id
    hook.sessionList.value = [{ id, name: displayName, project: 'The Brain', lastModified: new Date().toISOString() }]

    await hook.saveCurrentSession(displayName)

    const putCalls = mockSessionFetch.mock.calls.filter(([, opts]) => opts?.method === 'PUT')

    // Parent container PUT: URL ends with TomTwinProjects/ (trailing slash), label "TomTwinProjects".
    const parentPut = putCalls.find(([u]) => u === `${ROOT}/`)
    expect(parentPut).toBeTruthy()
    expect(parentPut[0].endsWith('/')).toBe(true)
    expect(parentPut[1].headers['Content-Type']).toBe('text/turtle')
    expect(parentPut[1].headers).not.toHaveProperty('Slug')
    expect(parentPut[1].body).toBe('<> rdfs:label "TomTwinProjects" .')

    // Project folder PUT: URL is {root}/<id>/ (stable id + trailing slash), label = display NAME.
    const folderPut = putCalls.find(([u]) => u === `${ROOT}/${id}/`)
    expect(folderPut).toBeTruthy()
    expect(folderPut[0].endsWith('/')).toBe(true)
    expect(folderPut[0]).toContain(`/${id}/`)            // path uses the stable id, not the name
    expect(folderPut[1].headers['Content-Type']).toBe('text/turtle')
    expect(folderPut[1].headers).not.toHaveProperty('Slug')
    expect(folderPut[1].body).toBe(`<> rdfs:label "${displayName}" .`)  // friendly name, not the id
  })

  // Quote-escaping: a project name containing a double-quote is escaped in the body
  // so the Turtle triple stays well-formed.
  test('_ensureContainer: project-folder label escapes double-quotes in the name', async () => {
    const id = 'quoted-yyyy'
    const displayName = 'My "Quoted" Project'
    mockHyperFetch.mockImplementation(async () => notFound())
    mockUploadFile.mockResolvedValue({ ok: true, status: 200 })

    const mockSessionFetch = vi.fn().mockImplementation(async (url, opts) => {
      if (opts?.method === 'HEAD') return { ok: false, status: 404 }
      if (opts?.method === 'PUT') return { ok: true, status: 200 }
      return { ok: false, status: 404 }
    })

    const { useSessionIndex } = await importHook()
    const docRef = ref('content')
    const hook = useSessionIndex({ document: docRef })
    hook.setPodRoot(POD_ROOT)
    hook.setSessionFetch(mockSessionFetch)
    hook.activeSessionId.value = id
    hook.sessionList.value = [{ id, name: displayName, project: 'The Brain', lastModified: new Date().toISOString() }]

    await hook.saveCurrentSession(displayName)

    const folderPut = mockSessionFetch.mock.calls.find(([u, opts]) => u === `${ROOT}/${id}/` && opts?.method === 'PUT')
    expect(folderPut).toBeTruthy()
    expect(folderPut[1].body).toBe('<> rdfs:label "My \\"Quoted\\" Project" .')
  })

  // HEAD-200 → no PUT: when the container already exists, ensureContainer skips the PUT.
  test('_ensureContainer: HEAD-200 → no PUT is issued (container already exists)', async () => {
    const id = 'ensure-head200-bbbb'
    mockHyperFetch.mockImplementation(async () => notFound())
    mockUploadFile.mockResolvedValue({ ok: true, status: 200 })

    const mockSessionFetch = vi.fn().mockImplementation(async (url, opts) => {
      if (opts?.method === 'HEAD') return { ok: true, status: 200 } // container exists
      return { ok: false, status: 404 }
    })

    const { useSessionIndex } = await importHook()
    const docRef = ref('content')
    const hook = useSessionIndex({ document: docRef })
    hook.setPodRoot(POD_ROOT)
    hook.setSessionFetch(mockSessionFetch)
    hook.activeSessionId.value = id
    hook.sessionList.value = [{ id, name: 'Test', project: 'The Brain', lastModified: new Date().toISOString() }]

    await hook.saveCurrentSession('Test')

    // No PUT should be issued via sessionFetch (container exists → skip).
    const putCalls = mockSessionFetch.mock.calls.filter(([, opts]) => opts?.method === 'PUT')
    expect(putCalls).toHaveLength(0)
  })

  // Guard prevents double-call: calling saveCurrentSession twice for the same project
  // only triggers one HEAD + one PUT for the <id>/ container (_projectContainersEnsured).
  test('_ensureContainer: guard prevents duplicate HEAD+PUT for the same project id', async () => {
    const id = 'ensure-guard-cccc'
    mockHyperFetch.mockImplementation(async () => notFound())
    mockUploadFile.mockResolvedValue({ ok: true, status: 200 })

    const mockSessionFetch = vi.fn().mockImplementation(async (url, opts) => {
      if (opts?.method === 'HEAD') return { ok: false, status: 404 }
      if (opts?.method === 'PUT') return { ok: true, status: 201 }
      return { ok: false, status: 404 }
    })

    const { useSessionIndex } = await importHook()
    const docRef = ref('content')
    const hook = useSessionIndex({ document: docRef })
    hook.setPodRoot(POD_ROOT)
    hook.setSessionFetch(mockSessionFetch)
    hook.activeSessionId.value = id
    hook.sessionList.value = [{ id, name: 'Test', project: 'The Brain', lastModified: new Date().toISOString() }]

    // First save: containers do not exist → HEAD+PUT fires for TomTwinProjects/ and <id>/.
    await hook.saveCurrentSession('Test')
    const callsAfterFirst = mockSessionFetch.mock.calls.length

    // Second save: guards are set → no new HEAD+PUT for either container.
    await hook.saveCurrentSession('Test')
    const callsAfterSecond = mockSessionFetch.mock.calls.length

    // No new sessionFetch calls between first and second save (guards fired, skipped).
    expect(callsAfterSecond).toBe(callsAfterFirst)
  })

  // PUT failure does not block save: if _ensureContainer's PUT returns an error,
  // saveCurrentSession continues and the file PUT (via ur.uploadFile) still runs.
  test('_ensureContainer: PUT failure does not block the file save', async () => {
    const id = 'ensure-failsafe-dddd'
    mockHyperFetch.mockImplementation(async () => notFound())
    mockUploadFile.mockResolvedValue({ ok: true, status: 200 })

    const mockSessionFetch = vi.fn().mockImplementation(async (url, opts) => {
      if (opts?.method === 'HEAD') return { ok: false, status: 404 }
      if (opts?.method === 'PUT') return { ok: false, status: 500 } // simulate server error
      return { ok: false, status: 404 }
    })

    const { useSessionIndex } = await importHook()
    const docRef = ref('content')
    const hook = useSessionIndex({ document: docRef })
    hook.setPodRoot(POD_ROOT)
    hook.setSessionFetch(mockSessionFetch)
    hook.activeSessionId.value = id
    hook.sessionList.value = [{ id, name: 'Test', project: 'The Brain', lastModified: new Date().toISOString() }]

    // Should not throw — failure is best-effort.
    await hook.saveCurrentSession('Test')

    // The file save (manifest + content via uploadFile) still ran despite PUT failure.
    const contentCall = mockUploadFile.mock.calls.find(([u]) => u === `${ROOT}/${id}/content.json`)
    expect(contentCall).toBeTruthy()
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

  // WRITE-ORDER DISCIPLINE (Cycle 066-extended rev3, 2026-06-04) — manifest.json
  // must be written BEFORE content.json inside saveCurrentSession so that on
  // strict-LDP pods (tst-planlegger.twinpod.eu) the manifest PUT auto-materializes
  // the <id>/ container, allowing the subsequent content.json PUT to succeed.
  //
  // This replaces the prior ensureContainer approach (dce9ccf) which used
  // text/turtle + BasicContainer Link header — broken post-2026-05-30.
  test('saveCurrentSession: manifest.json is PUT before content.json (write-order discipline)', async () => {
    const id = 'write-order-9999'
    mockHyperFetch.mockImplementation(async (url) => {
      if (url.endsWith('/index.json')) return notFound()
      return notFound()
    })
    mockUploadFile.mockResolvedValue({ ok: true, status: 201 })

    const { useSessionIndex } = await importHook()
    const docRef = ref('hello')
    const hook = useSessionIndex({ document: docRef })
    hook.setPodRoot(POD_ROOT)
    hook.sessionList.value = [{ id, name: 'Write Order Test', project: 'The Brain', lastModified: new Date().toISOString() }]
    hook.activeSessionId.value = id

    await hook.saveCurrentSession('Write Order Test')

    const putUrls = mockUploadFile.mock.calls.map(([u]) => u)
    const manifestIdx = putUrls.indexOf(`${ROOT}/${id}/manifest.json`)
    const contentIdx = putUrls.indexOf(`${ROOT}/${id}/content.json`)

    expect(manifestIdx).toBeGreaterThan(-1)   // manifest was written
    expect(contentIdx).toBeGreaterThan(-1)    // content was written
    expect(manifestIdx).toBeLessThan(contentIdx) // manifest FIRST, then content
  })
})
