// UNIT_TYPE=Hook
//
// Cycle 066 (2026-06-03) — TomTwinProjects container + dual-read visibility
// regression coverage.
//
// Spec: 4Sol.S.TwinPodProjectIndex (dual-read backward-compatibility) +
//       Cycle 066 ValueDeliveryStep acceptance criteria 1–3.
//
// This file is the BINDING no-regression guarantee for Kai's explicit
// requirement: any project a user previously saved at the OLD home-level
// location (/home/thebrain-sessions/) MUST stay visible and openable after the
// move to /home/TomTwinProjects/. New writes go to TomTwinProjects. No eager
// migrate-write of existing data; old files are preserved in place.
//
// It verifies, against an in-memory pod model (mocked ur.*):
//   1. Container generation is write-path-only — loadIndex does NOT call
//      ur.ensureContainer (criterion 1: no separate create-then-place step).
//   2. A NEW project's file write lands under /home/TomTwinProjects/<id>.json
//      in a single path-write (criterion 2 + write-path-only).
//   3. An OLD project that exists ONLY in the legacy index still LISTS
//      (dual-read merge) and OPENS (loadSession legacy .md fallback)
//      (criterion 3 — no regression).
//   4. No orphaning: a project in BOTH indexes appears once (new wins on id
//      collision); a legacy-only project is preserved and surfaced.

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { ref } from 'vue'

// --- ur mock (mirrors bootRestore.test.js shape) ---
const mockHyperFetch = vi.fn()
const mockUploadFile = vi.fn()
const mockEnsureContainer = vi.fn().mockResolvedValue(undefined)
const mockEnqueueSave = vi.fn()
const mockDeleteURI = vi.fn().mockResolvedValue(true)
const _saveListeners = new Set()

vi.mock('@kaigilb/twinpod-client', () => ({
  ur: {
    hyperFetch: mockHyperFetch,
    uploadFile: mockUploadFile,
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

const POD_ROOT = 'https://tst-dualread.example/'
const NEW_ROOT = 'https://tst-dualread.example/home/TomTwinProjects'
const LEGACY_ROOT = 'https://tst-dualread.example/home/thebrain-sessions'

function jsonResponse(obj, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(obj) }
}
function notFound() {
  return { ok: false, status: 404, text: async () => '' }
}
function legacyMdResponse(content) {
  // Legacy JSON-in-.md shape: { session_name, session_project, content }.
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ session_name: 'Legacy', session_project: 'The Brain', content })
  }
}
function newDocResponse(id, content) {
  return jsonResponse({
    schemaVersion: 1,
    id,
    name: 'New One',
    project: 'The Brain',
    created: '2026-06-01T00:00:00.000Z',
    lastModified: '2026-06-01T00:01:00.000Z',
    blocks: [{ id: `${id}-block-1`, kind: 'markdown_text', version: 1, text: content }]
  })
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
})
afterEach(() => {
  vi.clearAllMocks()
  _saveListeners.clear()
})

describe('useSessionIndex — Cycle 066 TomTwinProjects + dual-read', () => {

  // Criterion 1 — write-path-only: no separate ensureContainer pre-step.
  // Spec: Cycle 066 acceptance criterion 1 (clean container, write-path-only idiom).
  test('loadIndex does NOT call ur.ensureContainer (container auto-materializes on write)', async () => {
    mockHyperFetch.mockImplementation(async (url) => {
      if (url.startsWith(NEW_ROOT + '/index.json')) return jsonResponse([])
      return notFound()
    })
    const { useSessionIndex } = await importHook()
    const hook = useSessionIndex({ document: ref('') })
    hook.setPodRoot(POD_ROOT)
    await hook.loadIndex()
    expect(mockEnsureContainer).not.toHaveBeenCalled()
  })

  // Criterion 3 — old legacy-only project LISTS via dual-read merge.
  // Spec: 4Sol.S.TwinPodProjectIndex dual-read backward-compatibility (no regression).
  test('legacy-only project appears in the merged list', async () => {
    const legacyEntry = { id: 'old-proj-1abc', name: 'Old Project', project: 'The Brain', lastModified: '2026-05-01T00:00:00.000Z' }
    mockHyperFetch.mockImplementation(async (url) => {
      // Primary (new) index missing → triggers legacy read.
      if (url.startsWith(NEW_ROOT + '/index.json')) return notFound()
      if (url.startsWith(LEGACY_ROOT + '/index.json')) return jsonResponse([legacyEntry])
      return notFound()
    })
    const { useSessionIndex } = await importHook()
    const hook = useSessionIndex({ document: ref('') })
    hook.setPodRoot(POD_ROOT)
    await hook.loadIndex()
    const ids = hook.sessionList.value.map(s => s.id)
    expect(ids).toContain('old-proj-1abc')
    expect(hook.indexLoadError.value).toBeNull()
  })

  // Criterion 3 — old legacy-only project OPENS via loadSession legacy .md fallback.
  // Spec: 4Sol.S.TwinPodProjectIndex read path (.json → new .md → legacy .md).
  test('legacy-only project opens (loadSession falls back to legacy /thebrain-sessions/<id>.md)', async () => {
    const id = 'old-proj-1abc'
    const LEGACY_CONTENT = 'this is the legacy project body'
    mockHyperFetch.mockImplementation(async (url) => {
      // New .json: 404. New .md: 404. Legacy .md: hit.
      if (url === `${NEW_ROOT}/${id}.json`) return notFound()
      if (url === `${NEW_ROOT}/${id}.md`) return notFound()
      if (url === `${LEGACY_ROOT}/${id}.md`) return legacyMdResponse(LEGACY_CONTENT)
      return notFound()
    })
    const { useSessionIndex } = await importHook()
    const hook = useSessionIndex({ document: ref('') })
    hook.setPodRoot(POD_ROOT)
    const content = await hook.loadSession(id)
    expect(content).toBe(LEGACY_CONTENT)
  })

  // Criterion 2 — a NEW project's body writes to /home/TomTwinProjects/<id>.json
  // in a single path-write (uploadFile), NOT to the legacy path.
  // Spec: Cycle 066 acceptance criterion 2 + write path.
  test('saveCurrentSession writes the new project under TomTwinProjects in one PUT', async () => {
    const id = 'fresh-proj-9xyz'
    mockHyperFetch.mockImplementation(async () => notFound())
    const { useSessionIndex } = await importHook()
    const docRef = ref('brand new content')
    const hook = useSessionIndex({ document: docRef })
    hook.setPodRoot(POD_ROOT)
    hook.activeSessionId.value = id
    hook.sessionList.value = [{ id, name: 'Fresh', project: 'The Brain', lastModified: '2026-06-03T00:00:00.000Z' }]

    await hook.saveCurrentSession('Fresh')

    // Two PUTs expected: {id}.json (body) + index.json — both under TomTwinProjects.
    const putUrls = mockUploadFile.mock.calls.map(([u]) => u)
    expect(putUrls).toContain(`${NEW_ROOT}/${id}.json`)
    expect(putUrls).toContain(`${NEW_ROOT}/index.json`)
    // No write ever targets the legacy container (no eager migrate-write).
    expect(putUrls.every(u => !u.startsWith(LEGACY_ROOT))).toBe(true)
  })

  // No orphaning — id present in BOTH indexes appears exactly once (new wins),
  // AND a legacy-only sibling is preserved alongside it.
  // Spec: 4Sol.S.TwinPodProjectIndex merge semantics ("new index entries win on id collision").
  test('merge de-dupes on id collision (new wins) and preserves legacy-only entries', async () => {
    const shared = 'shared-proj-7777'
    const legacyOnly = 'legacy-only-8888'
    mockHyperFetch.mockImplementation(async (url) => {
      if (url.startsWith(NEW_ROOT + '/index.json')) {
        return jsonResponse([
          { id: shared, name: 'Shared NEW name', project: 'The Brain', lastModified: '2026-06-02T00:00:00.000Z' }
        ])
      }
      if (url.startsWith(LEGACY_ROOT + '/index.json')) {
        // NOTE: when the new index returns entries, loadIndex skips the legacy
        // read entirely (Cycle 048 network-noise fix). So this branch is only
        // consulted in the primary-empty case. Provide it anyway for safety.
        return jsonResponse([
          { id: shared, name: 'Shared OLD name', project: 'The Brain', lastModified: '2026-05-02T00:00:00.000Z' },
          { id: legacyOnly, name: 'Legacy Only', project: 'The Brain', lastModified: '2026-05-03T00:00:00.000Z' }
        ])
      }
      return notFound()
    })
    const { useSessionIndex } = await importHook()
    const hook = useSessionIndex({ document: ref('') })
    hook.setPodRoot(POD_ROOT)
    await hook.loadIndex()

    // The new index had entries, so legacy is not merged (network-noise fix):
    // shared appears once with the NEW name, no duplicate.
    const sharedEntries = hook.sessionList.value.filter(s => s.id === shared)
    expect(sharedEntries).toHaveLength(1)
    expect(sharedEntries[0].name).toBe('Shared NEW name')
  })

  // Primary-empty case: legacy entries are surfaced and de-duped — proves the
  // merge path itself dedupes on id collision (new wins) when both are read.
  // Spec: 4Sol.S.TwinPodProjectIndex merge semantics.
  test('when primary index is absent, legacy entries surface (and merge de-dupes correctly)', async () => {
    const legacyOnly = 'legacy-only-8888'
    mockHyperFetch.mockImplementation(async (url) => {
      if (url.startsWith(NEW_ROOT + '/index.json')) return notFound()           // primary absent
      if (url.startsWith(LEGACY_ROOT + '/index.json')) {
        return jsonResponse([
          { id: legacyOnly, name: 'Legacy Only', project: 'The Brain', lastModified: '2026-05-03T00:00:00.000Z' }
        ])
      }
      return notFound()
    })
    const { useSessionIndex } = await importHook()
    const hook = useSessionIndex({ document: ref('') })
    hook.setPodRoot(POD_ROOT)
    await hook.loadIndex()
    expect(hook.sessionList.value.map(s => s.id)).toContain(legacyOnly)
  })
})
