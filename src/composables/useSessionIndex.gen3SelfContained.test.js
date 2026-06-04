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
// mockEnqueueSave mirrors the real save-queue _drain: it fires the task
// IMMEDIATELY (in a microtask, like ur.enqueueSave → _drain) but returns a job
// id synchronously WITHOUT awaiting the task. This is what lets createNewSession
// be non-blocking AND still write to the pod promptly. Tests that assert the
// pod writes are present after createNewSession must therefore drain the
// microtask queue first (see drainQueue() below) — exactly the production
// timing (create resolves before the write completes). _lastSaveTask captures
// the task so a test can await it explicitly when needed.
let _lastSavePromise = null
let _saveJobCounter = 0
const mockEnqueueSave = vi.fn(({ task }) => {
  // Fire immediately, do not await — matches the real save-queue _drain
  // semantics (ur.enqueueSave kicks _drain which starts the task in the current
  // microtask but enqueueSave itself returns synchronously). Capture the in-
  // flight promise so a test can await its completion via drainQueue().
  _lastSavePromise = Promise.resolve().then(() => task())
  return `mock-save-${++_saveJobCounter}`
})
const mockDeleteURI = vi.fn().mockResolvedValue(true)
const _saveListeners = new Set()

// Await the most-recently-enqueued save task so its pod writes (manifest /
// content / index PUTs) have completed before assertions. The task is fired
// exactly ONCE by the mock; drainQueue only awaits that single in-flight run
// (it does not re-invoke the task). Mirrors the production fact that the write
// fires immediately and finishes a few microtasks later — the UI does not wait
// for it, but a test verifying the pod state must.
async function drainQueue() {
  if (_lastSavePromise) await _lastSavePromise
}

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
  _lastSavePromise = null
  _saveJobCounter = 0
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

  // NON-BLOCKING IMMEDIATE PERSIST (Cycle 067 rev2, 2026-06-04) — createNewSession
  // now routes the create-time pod write through the background-save queue
  // (enqueueWorkbookSave → ur.enqueueSave). The write FIRES IMMEDIATELY (the queue
  // mock kicks the task in the current microtask, mirroring _drain) but
  // createNewSession RESOLVES BEFORE the write completes (non-blocking — brief
  // fix 1). After draining the queue, the project's folder + manifest.json +
  // content.json + index.json are all on the pod with no user action and no
  // navigation trick — Step A's immediate-persist guarantee still holds.
  //
  // (This supersedes the Cycle 066-extended "createNewSession is fresh, no
  // content.json until first save" behaviour: the immediate save IS the first
  // save, so the session is no longer fresh after create and a follow-up rename
  // legitimately probes content.json — see the next test.)
  test('createNewSession fires the persist immediately (queued) and writes folder + manifest.json + content.json + index.json', async () => {
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

    // Non-blocking: the save was ENQUEUED (fires immediately) but createNewSession
    // did not await it. Prove the persist is queued through the canonical path.
    expect(mockEnqueueSave).toHaveBeenCalledTimes(1)
    expect(mockEnqueueSave.mock.calls[0][0].resourceKey).toBe(`${ROOT}/${id}/content.json`)

    // Drain the queued write, then assert the three pod files landed.
    await drainQueue()
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

  // NON-BLOCKING CONTRACT (Cycle 067 rev2 — brief fix 1, criterion a/c) —
  // createNewSession RESOLVES BEFORE the pod writes complete. We gate every
  // uploadFile behind a manually-released promise; if create awaited the write
  // it would hang on the gate. It must resolve while the writes are still in
  // flight (manifest + content issued in parallel, both pending), and only AFTER
  // we release the gate do the PUTs settle. This is the core "create feels
  // instant" guarantee: the UI is not blocked on the ~5 round-trip chain.
  test('createNewSession resolves before the pod writes complete; manifest+content issued in parallel', async () => {
    let releaseUploads
    const uploadGate = new Promise((res) => { releaseUploads = res })
    const issuedUrls = []

    mockHyperFetch.mockImplementation(async () => notFound())
    mockUploadFile.mockImplementation(async (url) => {
      issuedUrls.push(url) // record issue-time (synchronous, before the await)
      await uploadGate     // hold every PUT open until the test releases it
      return { ok: true, status: 200 }
    })

    const { useSessionIndex } = await importHook()
    const docRef = ref('')
    const hook = useSessionIndex({ document: docRef })
    hook.setPodRoot(POD_ROOT)

    // (a) createNewSession resolves even though all uploads are still gated.
    await hook.createNewSession()
    const id = hook.activeSessionId.value
    expect(id).toBeTruthy()

    // Let the queued save task start and issue its PUTs (still gated, unresolved).
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    // (c) manifest + content were BOTH issued (in parallel) while still pending —
    //     create did not wait for any of them to resolve.
    expect(issuedUrls).toContain(`${ROOT}/${id}/manifest.json`)
    expect(issuedUrls).toContain(`${ROOT}/${id}/content.json`)

    // Release the gate and let the background save finish.
    releaseUploads()
    await drainQueue()
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

    // Seed is synchronous (optimistic) — visible the instant create resolves.
    expect(docRef.value.startsWith('# My Cool Project')).toBe(true)
    // The persist is queued (non-blocking); drain it before asserting the write.
    await drainQueue()
    const manifestCall = mockUploadFile.mock.calls.find(([u]) => u === `${ROOT}/${id}/manifest.json`)
    expect(JSON.parse(manifestCall[1]).name).toBe('My Cool Project')
  })

  // RENAME-DURING-IN-FLIGHT-SAVE RACE (Cycle 047 resolve-name-at-PUT-time, must
  // NOT regress under the Cycle 067 rev2 non-blocking create). The rev2 change
  // makes the create-save run in the BACKGROUND, so a rename can now legitimately
  // fire WHILE the create-save's content.json PUT is still in flight — the exact
  // window Cycle 047 protects. The name must NOT pop back to the default:
  //   - saveCurrentSession resolves `name` from sessionList at PUT-TIME (not the
  //     enqueue-time parameter), and renameSession updated sessionList before the
  //     gated content PUT resolves.
  //   - the create-save's post-success sessionList.map only updates lastModified
  //     (never name), so it cannot clobber the rename.
  //   - the create-save's late saveIndex() reads the live (renamed) sessionList.
  // We gate ONLY content.json so the rename's own (ungated) saveIndex PUT can run,
  // letting us isolate the race.
  test('rename DURING the in-flight create-save keeps the new name (Cycle 047 race holds under non-blocking create)', async () => {
    let releaseContent
    const contentGate = new Promise((res) => { releaseContent = res })

    mockHyperFetch.mockImplementation(async () => notFound())

    const { useSessionIndex } = await importHook()
    const docRef = ref('')
    const hook = useSessionIndex({ document: docRef })
    hook.setPodRoot(POD_ROOT)

    // Gate ONLY the content.json PUT; everything else (manifest, index) resolves.
    let createId = null
    mockUploadFile.mockImplementation(async (url) => {
      if (createId && url === `${ROOT}/${createId}/content.json`) {
        await contentGate
      }
      return { ok: true, status: 200 }
    })

    // Create with a default name. The create-save enqueues + fires; its content
    // PUT will block on the gate, simulating an in-flight save.
    await hook.createNewSession({ name: 'Default Project Name' })
    createId = hook.activeSessionId.value
    expect(createId).toBeTruthy()

    // Let the background save start and reach the (now gated) content PUT.
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()

    // Rename WHILE the create-save's content.json is still in flight.
    await hook.renameSession(createId, 'User Renamed')

    // Release the gated content PUT and let the create-save finish.
    releaseContent()
    await drainQueue()

    // THE LOAD-BEARING GUARANTEE — the AUTHORITATIVE name sources hold the new
    // name and do NOT pop back to the default:
    //
    //   1. The live catalog entry (drives the project list / UI). renameSession's
    //      optimistic update set it; the create-save's post-success map only
    //      touches lastModified, never name → no clobber.
    const entry = hook.sessionList.value.find(s => s.id === createId)
    expect(entry.name).toBe('User Renamed')

    //   2. The LAST index.json PUT (the persisted derived catalog). Both the
    //      rename's own saveIndex and the create-save's late saveIndex read the
    //      LIVE sessionList, so whichever lands last carries 'User Renamed'.
    const indexPuts = mockUploadFile.mock.calls.filter(([u]) => u === `${ROOT}/index.json`)
    const lastIndex = JSON.parse(indexPuts[indexPuts.length - 1][1])
    expect(lastIndex.find(e => e.id === createId).name).toBe('User Renamed')

    // DENORMALIZED name mirrors in the in-flight save's bodies — pins CURRENT
    // behaviour, NON-load-bearing, self-corrects via autosave. The create-save
    // serialized its content.json AND manifest.json bodies at function ENTRY,
    // BEFORE the rename mutated sessionList, so both carry the create-time default.
    // This is NOT a regression and NOT a name-pop-back:
    //   - loadSession reads ONLY content.json's `created` + block text, never its
    //     `name`; the normal-login catalog comes from index.json (correct above).
    //   - manifest.name is read only by rebuildIndexFromManifests (the self-heal
    //     recovery path), so a stale manifest surfaces only if index.json is also
    //     lost AND a rebuild fires in this bounded window.
    //   - both self-correct: renameSession's heading-rewrite flips isDirty →
    //     autosave → a later (now un-fresh) saveCurrentSession rewrites content.json
    //     + manifest.json with the new name.
    // Asserted explicitly so the behaviour is pinned and visible, not silently
    // shipped. (See follow-ups — fixing at the create-save layer is impossible:
    // the rename postdates the body serialization.)
    const contentCall = mockUploadFile.mock.calls.find(([u]) => u === `${ROOT}/${createId}/content.json`)
    expect(JSON.parse(contentCall[1]).name).toBe('Default Project Name')
    const manifestCall = mockUploadFile.mock.calls.find(([u]) => u === `${ROOT}/${createId}/manifest.json`)
    expect(JSON.parse(manifestCall[1]).name).toBe('Default Project Name')
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

    // Drain the queued create-save so the session is no longer "fresh" (its
    // first content.json write has completed and cleared _freshSessions) — the
    // follow-up rename will then probe content.json as the standard Gen-3 path.
    await drainQueue()

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

  // PARALLEL WRITES (Cycle 067 rev2, 2026-06-04) — saveCurrentSession issues
  // manifest.json + content.json CONCURRENTLY via Promise.allSettled rather than
  // in strict sequence, halving write latency on the create critical path.
  //
  // This RETIRES the prior "manifest must complete before content" write-order
  // discipline (Cycle 066-extended rev3). That belt-and-suspenders ordering
  // existed so the manifest PUT would auto-materialize the <id>/ container before
  // the content PUT on strict-LDP pods. It is now redundant: _ensureContainer
  // (rev4) creates the <id>/ container before EITHER PUT (covered by the
  // _ensureContainer tests above), so neither write depends on the other to
  // materialize the folder. We assert both PUTs are ISSUED (the container is
  // already ensured), not a completion order that the parallel design no longer
  // guarantees.
  test('saveCurrentSession: manifest.json + content.json are both issued (parallel writes, no completion-order dependency)', async () => {
    const id = 'parallel-9999'
    mockHyperFetch.mockImplementation(async (url) => {
      if (url.endsWith('/index.json')) return notFound()
      return notFound()
    })
    mockUploadFile.mockResolvedValue({ ok: true, status: 201 })

    const { useSessionIndex } = await importHook()
    const docRef = ref('hello')
    const hook = useSessionIndex({ document: docRef })
    hook.setPodRoot(POD_ROOT)
    hook.sessionList.value = [{ id, name: 'Parallel Test', project: 'The Brain', lastModified: new Date().toISOString() }]
    hook.activeSessionId.value = id

    await hook.saveCurrentSession('Parallel Test')

    const putUrls = mockUploadFile.mock.calls.map(([u]) => u)
    expect(putUrls).toContain(`${ROOT}/${id}/manifest.json`)  // manifest written
    expect(putUrls).toContain(`${ROOT}/${id}/content.json`)   // content written
    expect(putUrls).toContain(`${ROOT}/index.json`)           // index still written
  })

  // PARALLELISM PROOF (Cycle 067 rev2) — the manifest and content PUTs are
  // in-flight CONCURRENTLY, not serialised. We block the manifest upload on a
  // gate the test controls; if the writes were sequential the content PUT would
  // never be issued until the manifest resolves. With parallel issue, BOTH
  // uploadFile calls are made before either resolves.
  test('saveCurrentSession: content.json PUT is issued before manifest.json PUT resolves (truly parallel)', async () => {
    const id = 'concurrent-aaaa'
    let releaseManifest
    const manifestGate = new Promise((res) => { releaseManifest = res })
    let contentIssuedWhileManifestPending = false

    mockHyperFetch.mockImplementation(async (url) => {
      if (url.endsWith('/index.json')) return notFound()
      return notFound()
    })
    mockUploadFile.mockImplementation(async (url) => {
      if (url === `${ROOT}/${id}/manifest.json`) {
        await manifestGate // hold the manifest PUT open
        return { ok: true, status: 200 }
      }
      if (url === `${ROOT}/${id}/content.json`) {
        // If this runs while the manifest is still gated, the writes are parallel.
        contentIssuedWhileManifestPending = true
        return { ok: true, status: 200 }
      }
      return { ok: true, status: 200 }
    })

    const { useSessionIndex } = await importHook()
    const docRef = ref('hello')
    const hook = useSessionIndex({ document: docRef })
    hook.setPodRoot(POD_ROOT)
    hook.sessionList.value = [{ id, name: 'Concurrent', project: 'The Brain', lastModified: new Date().toISOString() }]
    hook.activeSessionId.value = id

    const savePromise = hook.saveCurrentSession('Concurrent')
    // Let microtasks run: the content PUT should fire even though manifest is gated.
    await Promise.resolve()
    await Promise.resolve()
    expect(contentIssuedWhileManifestPending).toBe(true)

    releaseManifest()
    await savePromise
  })

  // FAILURE SEMANTICS under parallel writes (Cycle 067 rev2) — preserved exactly
  // from the prior sequential implementation:
  //   - content-write failure → isDirty restored (autosave retries) + localStorage
  //     backup KEPT (not cleared).
  //   - manifest-write failure → NON-FATAL: surfaced, isDirty NOT restored.
  // allSettled (not Promise.all) is required so a manifest-only network THROW does
  // not restore isDirty.
  test('parallel-write failure semantics: content fail restores isDirty + keeps backup; manifest fail is non-fatal', async () => {
    const { useSessionIndex } = await importHook()
    const docRef = ref('body to save')

    // --- Case 1: content PUT fails (!ok) → isDirty restored, backup kept. ---
    const idC = 'fail-content-bbbb'
    mockHyperFetch.mockImplementation(async () => notFound())
    mockUploadFile.mockImplementation(async (url) => {
      if (url === `${ROOT}/${idC}/content.json`) return { ok: false, status: 500 }
      return { ok: true, status: 200 }
    })
    const hookC = useSessionIndex({ document: docRef })
    hookC.setPodRoot(POD_ROOT)
    hookC.sessionList.value = [{ id: idC, name: 'C', project: 'The Brain', lastModified: new Date().toISOString() }]
    hookC.activeSessionId.value = idC

    await hookC.saveCurrentSession('C')
    expect(hookC.isDirty.value).toBe(true) // content failure → retry armed
    // Guard C backup survives a failed content write (recoverable at next boot).
    expect(_store.get(`theBrain.lastWorkbookDraft.${idC}`)).toBeTruthy()

    // --- Case 2: content PUT THROWS (network) → isDirty restored. ---
    const idT = 'fail-throw-cccc'
    mockUploadFile.mockImplementation(async (url) => {
      if (url === `${ROOT}/${idT}/content.json`) throw new Error('network down')
      return { ok: true, status: 200 }
    })
    const hookT = useSessionIndex({ document: ref('x') })
    hookT.setPodRoot(POD_ROOT)
    hookT.sessionList.value = [{ id: idT, name: 'T', project: 'The Brain', lastModified: new Date().toISOString() }]
    hookT.activeSessionId.value = idT

    await hookT.saveCurrentSession('T')
    expect(hookT.isDirty.value).toBe(true) // throw treated same as !ok

    // --- Case 3: manifest fails but content succeeds → NON-FATAL (isDirty NOT set). ---
    const idM = 'fail-manifest-dddd'
    mockUploadFile.mockImplementation(async (url) => {
      if (url === `${ROOT}/${idM}/manifest.json`) throw new Error('manifest network blip')
      return { ok: true, status: 200 }
    })
    const hookM = useSessionIndex({ document: ref('y') })
    hookM.setPodRoot(POD_ROOT)
    hookM.sessionList.value = [{ id: idM, name: 'M', project: 'The Brain', lastModified: new Date().toISOString() }]
    hookM.activeSessionId.value = idM

    await hookM.saveCurrentSession('M')
    // Manifest failure is non-fatal: the authoritative content write succeeded, so
    // isDirty must NOT be restored (a Promise.all+catch regression would set it).
    expect(hookM.isDirty.value).toBe(false)
    expect(hookM.sessionSaveError.value).toMatch(/manifest/i)
  })
})
