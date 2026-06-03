// UNIT_TYPE=Hook
//
// Regression coverage for Cycle 048 Guard C boot-restore race fix
// (2026-05-24).
//
// Bug being prevented (network-block recovery, Goal 1 — durability):
//   1. User edits a session while online — autosave PUT succeeds.
//   2. Network goes offline; user types another line; autosave fires,
//      queued PUT fails. localStorage backup (Guard C) holds the
//      content including the offline line.
//   3. User closes the tab.
//   4. User reopens the app online; app auto-loads most-recent session.
//   5. Boot reads pod content (without offline line). Without this fix,
//      the previous App.vue boot-restore watcher fires its restore from
//      a nextTick scheduled BEFORE loadSession resolves — the restore
//      writes the backup into document, then loadSession's
//      `document.value = content` clobbers it on the very next line.
//
// The fix moves the boot-restore call INSIDE switchToSession in the
// package — it runs AFTER `document.value = content` settles, so the
// restore actually wins. switchToSession also synchronously enqueues a
// save so the pod catches up the moment the network returns (we do not
// rely on the autosave watcher being installed at the right moment).
//
// This file exercises switchToSession against an in-memory localStorage
// shim and verifies:
//   - With a backup that differs from the pod, document.value ends up
//     holding the backup (NOT the pod) after switchToSession resolves.
//   - The returned status is { restored: true }.
//   - A save is enqueued against the session JSON resourceKey AFTER the
//     restore (so pod catches up).
//   - With no backup (or matching backup), no restore happens and no
//     extra enqueue fires.

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { ref } from 'vue'

// Drive ur.enqueueSave synchronously: run task immediately, emit succeeded.
const _saveListeners = new Set()
function _emitSave(evt) {
  for (const l of [..._saveListeners]) l(evt)
}

const mockHyperFetch = vi.fn()
const mockUploadFile = vi.fn()
const mockEnsureContainer = vi.fn().mockResolvedValue(undefined)
const mockEnqueueSave = vi.fn()
const mockDeleteURI = vi.fn().mockResolvedValue(true)

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

// Tiny in-memory localStorage shim. The tests don't go through window —
// the composable's localStorage helpers use `window.localStorage`, so we
// stand up a fake `window` for the test environment.
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

beforeEach(() => {
  vi.clearAllMocks()
  _saveListeners.clear()
  _store.clear()

  // Default queue behaviour mirrors useCreditLedger.test.js: run task in a
  // microtask, emit succeeded with the task's result.
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

  // ensureContainer is no-op by default.
  mockEnsureContainer.mockResolvedValue(undefined)
  // uploadFile is treated as successful by default (regression for the
  // post-restore enqueue path — the queue should fire saveCurrentSession,
  // which calls uploadFile).
  mockUploadFile.mockResolvedValue({ ok: true, status: 200 })
})

afterEach(() => {
  vi.clearAllMocks()
  _saveListeners.clear()
})

// Helper: build a successful loadSession JSON response.
function makeJsonResponse(content) {
  const body = JSON.stringify({
    schemaVersion: 1,
    id: 'sess-1',
    name: 'Session 1',
    project: 'The Brain',
    created: '2026-05-24T00:00:00.000Z',
    lastModified: '2026-05-24T00:01:00.000Z',
    blocks: [
      { id: 'sess-1-block-1', kind: 'markdown_text', version: 1, text: content }
    ]
  })
  return {
    ok: true,
    status: 200,
    text: async () => body
  }
}

// Helper: import useSessionIndex AFTER vi.mock has been applied.
async function importHook() {
  const mod = await import('./useSessionIndex.js')
  // Reset module-level state so each test starts clean.
  mod._resetModuleStateForTesting()
  return mod
}

describe('useSessionIndex switchToSession — Guard C boot-restore (Cycle 048 regression)', () => {
  test('restores localStorage backup AFTER loadSession completes (no clobber)', async () => {
    const POD_ROOT = 'https://kai.example/'
    const SESSION_ID = 'sess-1'
    // Pod has just "first line". Backup has "first line + OFFLINE TEST LINE".
    const POD_CONTENT = 'first line'
    const BACKUP_CONTENT = 'first line\nOFFLINE TEST LINE'

    // Seed Guard C backup.
    _store.set(
      `theBrain.lastWorkbookDraft.${SESSION_ID}`,
      JSON.stringify({ content: BACKUP_CONTENT, savedAt: '2026-05-24T00:02:00.000Z' })
    )

    // loadSession reads the session JSON file. Return the pod content.
    mockHyperFetch.mockImplementation(async (url) => {
      if (url.endsWith(`/${SESSION_ID}.json`)) return makeJsonResponse(POD_CONTENT)
      // Index reads are NOT triggered by switchToSession (only by loadIndex).
      return { ok: false, status: 404, text: async () => '' }
    })

    const { useSessionIndex } = await importHook()
    const documentRef = ref('')
    const hook = useSessionIndex({ document: documentRef })
    hook.setPodRoot(POD_ROOT)
    // Pre-populate sessionList so switchToSession's name lookup works.
    hook.sessionList.value = [
      { id: SESSION_ID, name: 'Session 1', project: 'The Brain', lastModified: '2026-05-24T00:01:00.000Z' }
    ]

    const result = await hook.switchToSession(SESSION_ID)

    // Critical assertion: the OFFLINE TEST LINE survived the load race.
    expect(documentRef.value).toBe(BACKUP_CONTENT)
    expect(result).toEqual({ restored: true })

    // Post-restore enqueue: a save MUST have been scheduled against the
    // session content resourceKey so the pod catches up the moment the
    // network is back. Cycle 066-extended: the queue resourceKey is the Gen-3
    // content path {root}/<id>/content.json (the file saveCurrentSession PUTs).
    expect(mockEnqueueSave).toHaveBeenCalled()
    const expectedResourceKey = `${POD_ROOT.replace(/\/+$/, '')}/home/TomTwinProjects/${SESSION_ID}/content.json`
    const enqueuedKeys = mockEnqueueSave.mock.calls.map(([opts]) => opts.resourceKey)
    expect(enqueuedKeys).toContain(expectedResourceKey)
  })

  test('does NOT restore when backup matches pod content (no spurious enqueue)', async () => {
    const POD_ROOT = 'https://kai.example/'
    const SESSION_ID = 'sess-1'
    const CONTENT = 'first line'

    // Backup matches pod — restore is a no-op and the backup should be
    // cleared (existing behaviour preserved).
    _store.set(
      `theBrain.lastWorkbookDraft.${SESSION_ID}`,
      JSON.stringify({ content: CONTENT, savedAt: '2026-05-24T00:02:00.000Z' })
    )

    mockHyperFetch.mockImplementation(async (url) => {
      if (url.endsWith(`/${SESSION_ID}.json`)) return makeJsonResponse(CONTENT)
      return { ok: false, status: 404, text: async () => '' }
    })

    const { useSessionIndex } = await importHook()
    const documentRef = ref('')
    const hook = useSessionIndex({ document: documentRef })
    hook.setPodRoot(POD_ROOT)
    hook.sessionList.value = [
      { id: SESSION_ID, name: 'Session 1', project: 'The Brain', lastModified: '2026-05-24T00:01:00.000Z' }
    ]

    const result = await hook.switchToSession(SESSION_ID)

    expect(documentRef.value).toBe(CONTENT)
    expect(result).toEqual({ restored: false })
    // No save should have been enqueued — nothing to recover.
    expect(mockEnqueueSave).not.toHaveBeenCalled()
    // Backup should be cleared (matching backup is now stale).
    expect(_store.has(`theBrain.lastWorkbookDraft.${SESSION_ID}`)).toBe(false)
  })

  test('does NOT restore when no backup exists', async () => {
    const POD_ROOT = 'https://kai.example/'
    const SESSION_ID = 'sess-1'
    const CONTENT = 'first line'

    // No backup seeded.

    mockHyperFetch.mockImplementation(async (url) => {
      if (url.endsWith(`/${SESSION_ID}.json`)) return makeJsonResponse(CONTENT)
      return { ok: false, status: 404, text: async () => '' }
    })

    const { useSessionIndex } = await importHook()
    const documentRef = ref('')
    const hook = useSessionIndex({ document: documentRef })
    hook.setPodRoot(POD_ROOT)
    hook.sessionList.value = [
      { id: SESSION_ID, name: 'Session 1', project: 'The Brain', lastModified: '2026-05-24T00:01:00.000Z' }
    ]

    const result = await hook.switchToSession(SESSION_ID)

    expect(documentRef.value).toBe(CONTENT)
    expect(result).toEqual({ restored: false })
    expect(mockEnqueueSave).not.toHaveBeenCalled()
  })
})
