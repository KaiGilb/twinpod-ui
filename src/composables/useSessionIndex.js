// UNIT_TYPE=Hook

/**
 * useSessionIndex
 *
 * Manages the session index for The Brain app: a JSON file at
 * {podRoot}/home/TomTwinProjects/index.json containing session metadata,
 * and individual session .md files at {podRoot}/home/TomTwinProjects/{id}.md.
 *
 * Storage path is governed by the single module-level constant SESSIONS_ROOT_PATH.
 * Changing the sessions storage location means editing one line — no other file
 * hardcodes this path string.
 *
 * Spec: 4Sol.S.TwinPodSessionIndex, 3P.F.SessionCreate, 3P.F.SessionSave,
 *       3P.F.SessionSwitch, 3P.F.SessionRename, 3P.V.SessionProjectChangeability
 *
 * TwinPod single-namespace rule: all pod I/O goes through ur.hyperFetch or ur.uploadFile.
 * NEVER call window.solid.session.fetch, session.fetch, or fetch() directly against a pod URL.
 *
 * OWNERSHIP NOTE: workbookContent is owned by usePodWorkbook.js — this composable
 * reads and writes it (via the ref passed in) but does NOT own it. The single
 * source of truth for workspace content is the document ref in useWorkspace.js.
 *
 * Subdirectory support: CONFIRMED via Cycle 12 (LDP BasicContainer PUT to
 * {podRoot}/home/TomTwin/ succeeded). The same pattern is used for
 * SESSIONS_ROOT_PATH = '/home/TomTwinProjects'. Container creation is
 * idempotent — 409 is acceptable.
 *
 * @param {{ document: import('vue').Ref<string> }} workbookRefs
 *   An object containing the shared document ref from useWorkspace. Passed in
 *   by App.vue to avoid ownership conflict with usePodWorkbook.
 *
 * @returns {{
 *   sessionList:          import('vue').Ref<Array<{id:string,name:string,project:string,lastModified:string}>>,
 *   activeSessionId:      import('vue').Ref<string|null>,
 *   indexLoading:         import('vue').Ref<boolean>,
 *   indexLoadError:       import('vue').Ref<string|null>,
 *   sessionSaving:        import('vue').Ref<boolean>,
 *   sessionSaveError:     import('vue').Ref<string|null>,
 *   isSessionLoading:     import('vue').Ref<boolean>,
 *   isDirty:              import('vue').Ref<boolean>,
 *   loadIndex:            () => Promise<void>,
 *   saveIndex:            () => Promise<void>,
 *   createNewSession:     () => Promise<void>,
 *   saveCurrentSession:   (name: string) => Promise<void>,
 *   loadSession:          (id: string) => Promise<string>,
 *   switchToSession:      (id: string) => Promise<void>,
 *   renameSession:        (id: string, newName: string) => Promise<void>,
 *   renameSessionProject: (id: string, newProject: string) => Promise<void>,
 *   setupSessionAutosave: (debouncedMs?: number) => void
 * }}
 *
 * Preconditions:
 *   - window.solid.session must be set before calling any async method.
 *     App.vue bridges session in Cycle 12 Evo1.
 *   - podRoot must be provided via inject('podRoot') in App.vue before calling loadIndex().
 *
 * Errors:
 *   - indexLoadError: set on non-404 load failures; null on success or 404.
 *   - sessionSaveError: set on save failures; null on success.
 *
 * @example
 * const { sessionList, loadIndex, createNewSession } = useSessionIndex({ document })
 * await loadIndex()
 * await createNewSession()
 */

import { ref, watch } from 'vue'
// ur namespace import below also wires ur.enqueueSave / ur.onSaveEvent via
// twinpod-client's main entry (src/index.js side-effect-imports save-queue.js).
import { ur } from '@kaigilb/twinpod-client'

// --- Single configurable constant for sessions storage root ---
//
// All path construction in this file uses this constant.
// No other file may hardcode this path string.
// Confirmed: pod /home/ surface supports subdirectory PUT (Cycle 12, LDP BasicContainer pattern).
// To use flat-file fallback, change this to '/home/TomTwinProjects' prefix and adjust
// _sessionsRoot() to return podRoot + SESSIONS_ROOT_PATH (no trailing slash) as a prefix
// rather than a directory.
const SESSIONS_ROOT_PATH = '/home/TomTwinProjects'

// Legacy path — the original production location for session files (pre-Cycle-021).
// Read-only fallback to surface existing user data after the path rename. Saves always
// go to the new SESSIONS_ROOT_PATH; legacy files are auto-migrated on next save (the
// old file remains as a historical artefact, not deleted).
// Source: Kai, 2026-05-11 — one production user has data here; do not orphan their projects.
const LEGACY_SESSIONS_ROOT_PATH = '/home/thebrain-sessions'

// --- Typed-block document schema ---
//
// Spec: 4Sol.S.TwinPodSessionIndex (revised 2026-05-10) — typed-JSON-document format.
// Each session file is a JSON document whose `blocks` array contains typed-block objects.
// The block kind is an extension point: adding a new kind is a registry-extension change,
// NOT a document-schema-version bump. The document's `schemaVersion` only changes when
// the top-level document shape changes (e.g. a new top-level key is added that older code
// must migrate). New block kinds extend BLOCK_KINDS below.
//
// For the bootstrap increment (TypedJSONDocSessionFormat), only 'markdown_text' is defined.
const DOC_SCHEMA_VERSION = 1
const BLOCK_KINDS = {
  markdown_text: { version: 1 }
}

// Module-level state so App.vue and all injected children share the same reactive refs.
const sessionList = ref([])
const activeSessionId = ref(null)
const indexLoading = ref(false)
const indexLoadError = ref(null)
const sessionSaving = ref(false)
const sessionSaveError = ref(null)

// isSessionLoading drives the "Loading Project..." overlay in
// WorkspacePane.vue. Set true while switchToSession() is in flight
// (including any autosave of the outgoing session) and reset in a
// finally block so a thrown loadSession does not leave it stuck.
const isSessionLoading = ref(false)

// isDirty tracks unsaved changes in workbookContent.
// Set to true by watch on workbookContent after initial load.
// Reset to false before each saveCurrentSession() call (prevent double-save race).
const isDirty = ref(false)

// Per-session in-memory metadata: created timestamp (preserved across saves) and a
// legacy-loaded flag (set when a session was loaded from the legacy JSON-in-.md or
// text+frontmatter shape, so we know the next save persists in the new .json shape).
// Keyed by session id. Not persisted — re-derived from the loaded body.
const _sessionMeta = new Map()

// podRoot captured from App.vue provide context — set once at loadIndex() call time.
let _podRoot = ''

// Reference to the autosave debounce timer — held module-level so it can be cleared.
let _autosaveTimer = null

// Last-saved snapshot of the document content. Used by the change-aware
// autosave watcher (Cycle 045 iter-2, 2026-05-21) to distinguish a real user
// edit from a reactive re-assignment that did not change content (hydration,
// scroll restoration, session switch). Without this gate the original watcher
// fired saveCurrentSession on ANY mutation of the document ref — including
// the load path that hydrates an empty workspace at boot, producing spurious
// saves and pod write traffic.
//
// Initialised to an empty string so the first user keystroke on a clean
// workspace (whose initial document.value is also '') is correctly detected
// — the watcher only fires after isDirty flips, which only happens after the
// content actually differs from '_lastSavedContent'.
let _lastSavedContent = ''

// Guard A first-edit save timer REMOVED (Cycle 045, 2026-05-21). The watcher
// it backed caused save-per-keystroke instead of save-per-pause — see the
// REMOVED comment in setupSessionAutosave for the full reasoning. The
// change-aware debounce watcher is sufficient on its own; explicit pre-
// redirect saves go through ensureSessionSaved (Guard B) which awaits
// saveCurrentSession directly without needing a timer ref.

// localStorage backup key prefix (Guard C — belt-and-suspenders safety net).
// Every saveCurrentSession call mirrors the workbook content here under
// the active session id. On app boot, App.vue checks for a more-recent
// backup than the pod and offers to restore.
const LOCALSTORAGE_BACKUP_PREFIX = 'theBrain.lastWorkbookDraft.'

// Scratch-draft localStorage key (Emergency hotfix round 2, 2026-05-14).
//
// Round 1 (Guards A/B/C) protected users WITH an active session id. The
// prior emergency missed the actual user case: users land on `/` (no
// `/project/<slug>`), the shared workbook is rendered as the default
// landing surface, and `activeSessionId.value === null`. When such a user
// types into the workbook and then clicks Buy Credits, the Stripe redirect
// kills the JS context. On return, the module-level `document` ref is
// freshly initialised to '' — work is lost.
//
// This key is independent of session id: it backs up the raw `document`
// ref content so even when there is no session yet the keystrokes survive
// a redirect. Boot logic checks for a fresh (<24h) scratch entry when
// `sessionList` is empty and restores it. Layer 1 (auto-create-session
// watcher in App.vue) converts the scratch into a real session as soon as
// the user resumes editing post-restore.
const SCRATCH_DRAFT_KEY = 'theBrain.scratchDraft.v1'
const SCRATCH_DRAFT_MAX_AGE_MS = 24 * 60 * 60 * 1000

/**
 * Resets all module-level state to initial values.
 * FOR TESTING ONLY — do not call in production code.
 * Necessary because module-level refs persist across test cases in Vitest.
 */
export function _resetModuleStateForTesting() {
  sessionList.value = []
  activeSessionId.value = null
  indexLoading.value = false
  indexLoadError.value = null
  sessionSaving.value = false
  sessionSaveError.value = null
  isSessionLoading.value = false
  isDirty.value = false
  _podRoot = ''
  _autosaveTimer = null
  _lastSavedContent = ''
  _sessionMeta.clear()
}

// Helper key for localStorage backups (Guard C).
function _localStorageBackupKey(sessionId) {
  return LOCALSTORAGE_BACKUP_PREFIX + sessionId
}

/**
 * Write a localStorage backup of the workbook content for the given session.
 * Guard C — belt-and-suspenders safety net so a failed pod save does not
 * lose the user's keystrokes. Called from every saveCurrentSession attempt
 * before the network call, so even if the pod write fails the draft persists.
 *
 * Safe in non-browser test environments — typeof window guard.
 *
 * @param {string} sessionId - Active session id.
 * @param {string} content - Workbook content to back up.
 */
export function _writeLocalStorageBackup(sessionId, content) {
  if (typeof window === 'undefined' || !window.localStorage) return
  if (!sessionId) return
  try {
    const payload = JSON.stringify({
      content: content ?? '',
      savedAt: new Date().toISOString()
    })
    window.localStorage.setItem(_localStorageBackupKey(sessionId), payload)
  } catch {
    // localStorage may be full or disabled (private mode). Best-effort only.
  }
}

/**
 * Read a localStorage backup for the given session, if present.
 * Returns null if missing or malformed. Used by App.vue at boot to
 * detect drafts that did not make it to the pod (e.g. lost via the
 * Stripe pay-gate redirect race).
 *
 * @param {string} sessionId - Session id to look up.
 * @returns {{ content: string, savedAt: string } | null}
 */
export function _readLocalStorageBackup(sessionId) {
  if (typeof window === 'undefined' || !window.localStorage) return null
  if (!sessionId) return null
  try {
    const raw = window.localStorage.getItem(_localStorageBackupKey(sessionId))
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (typeof parsed?.content !== 'string') return null
    return parsed
  } catch {
    return null
  }
}

/**
 * Remove a localStorage backup for the given session.
 * Called after a successful pod save so the backup does not grow stale
 * relative to the canonical pod copy.
 *
 * @param {string} sessionId - Session id.
 */
export function _clearLocalStorageBackup(sessionId) {
  if (typeof window === 'undefined' || !window.localStorage) return
  if (!sessionId) return
  try {
    window.localStorage.removeItem(_localStorageBackupKey(sessionId))
  } catch {
    // No-op.
  }
}

/**
 * Write the session-agnostic scratch-draft localStorage entry.
 *
 * Emergency hotfix round 2 (2026-05-14): protects users WITHOUT an active
 * session id. Round 1 Guard C is keyed by `sessionId` and is a no-op when
 * there is no session. This entry exists exactly to cover that gap.
 *
 * Empty strings are intentionally NOT written — there is nothing to recover
 * and a stale empty entry would mask a legitimate non-empty key if the
 * caller re-orders writes. The boot-time reader treats absence as "no work
 * to restore" which is the correct UX.
 *
 * Safe in non-browser test environments — typeof window guard.
 *
 * @param {string} content - Workbook content to back up.
 */
export function _writeScratchDraft(content) {
  if (typeof window === 'undefined' || !window.localStorage) return
  // Empty content carries no information worth restoring. Skipping the
  // write also avoids racing with `_clearScratchDraft` after auto-create.
  if (!content) return
  try {
    const payload = JSON.stringify({
      content,
      timestamp: new Date().toISOString()
    })
    window.localStorage.setItem(SCRATCH_DRAFT_KEY, payload)
  } catch {
    // localStorage full / disabled — best-effort only.
  }
}

/**
 * Read the session-agnostic scratch-draft entry, if present and fresh.
 *
 * Returns null when:
 *   - localStorage is unavailable.
 *   - The key is absent.
 *   - The stored JSON is malformed.
 *   - The stored timestamp is older than 24 hours (stale — discard).
 *
 * Staleness rule (24h): a redirect that takes longer than a day suggests
 * the user abandoned the flow; restoring would surprise more than help.
 * The 24h window covers Stripe Checkout (typically minutes) with slack.
 *
 * @returns {{ content: string, timestamp: string } | null}
 */
export function _readScratchDraft() {
  if (typeof window === 'undefined' || !window.localStorage) return null
  try {
    const raw = window.localStorage.getItem(SCRATCH_DRAFT_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (typeof parsed?.content !== 'string') return null
    if (typeof parsed?.timestamp !== 'string') return null
    if (!parsed.content) return null
    const ts = new Date(parsed.timestamp).getTime()
    if (!Number.isFinite(ts)) return null
    if (Date.now() - ts > SCRATCH_DRAFT_MAX_AGE_MS) {
      // Stale — discard so it does not shadow legitimate future writes.
      try { window.localStorage.removeItem(SCRATCH_DRAFT_KEY) } catch { /* no-op */ }
      return null
    }
    return parsed
  } catch {
    return null
  }
}

/**
 * Remove the session-agnostic scratch-draft entry.
 *
 * Called when the scratch content has been promoted to a real session
 * (Layer 1 auto-create path in App.vue) so the session-keyed backup
 * (Guard C from round 1) takes over.
 */
export function _clearScratchDraft() {
  if (typeof window === 'undefined' || !window.localStorage) return
  try {
    window.localStorage.removeItem(SCRATCH_DRAFT_KEY)
  } catch {
    // No-op.
  }
}

export function useSessionIndex({ document }) {

  // --- Internal helpers ---

  /**
   * Returns the sessions container URL for the current pod.
   * All paths in this composable build from this string.
   * @returns {string}
   */
  function sessionsRoot() {
    // Strip trailing slash from podRoot so SESSIONS_ROOT_PATH appends cleanly.
    return _podRoot.replace(/\/+$/, '') + SESSIONS_ROOT_PATH
  }

  /**
   * Returns the LEGACY sessions container URL for the current pod.
   * Used by loadIndex and loadSession for read-only fallback so existing user data
   * surfaces after the SESSIONS_ROOT_PATH rename. Saves always target sessionsRoot().
   * @returns {string}
   */
  function legacySessionsRoot() {
    return _podRoot.replace(/\/+$/, '') + LEGACY_SESSIONS_ROOT_PATH
  }

  /**
   * Ensures the sessions container exists on the pod using an LDP BasicContainer PUT.
   * Idempotent — 409 (already exists) is treated as success.
   * Uses the same pattern as Cycle 12 (usePodWorkbook.js container creation).
   * @returns {Promise<void>}
   */
  async function ensureSessionsContainer() {
    // /home/ exists by default on TwinPod, so we only need to ensure the leaf container.
    // PUT is idempotent (409 = already exists). The TwinPodData container at /apps/TomTwin/
    // is ensured by useCreditLedger / useUserFactStore — not our concern here.
    const containerUrl = sessionsRoot() + '/'
    await ur.hyperFetch(containerUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': 'text/turtle',
        'Link': '<http://www.w3.org/ns/ldp#BasicContainer>; rel="type"'
      },
      // rdfs:label gives the container a human-readable name in the pod browser.
      body: '@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .\n<> rdfs:label "TomTwinProjects" .\n'
    })
    // 409 = already exists — acceptable; response status not checked here because
    // the file PUT immediately after will surface real auth/network failures.
  }

  // --- Session ID generation ---

  /**
   * Generates a URL-safe session ID from a human-readable name.
   * Format: lowercased-slugified-name + '-' + 4-char random alphanumeric suffix.
   *
   * @param {string} name - Human-readable session name.
   * @returns {string} URL-safe slug, e.g. 'new-session-2026-04-26-a3f7'.
   */
  function generateSessionId(name) {
    const slug = name
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9-]/g, '')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
    const suffix = Math.random().toString(36).slice(2, 6)
    return (slug || 'session') + '-' + suffix
  }

  // --- Read path ---

  /**
   * Fetches index.json from the pod and populates sessionList.
   *
   * On 404: treats as empty index (first use) — sets sessionList to [].
   * On other errors: sets indexLoadError.
   *
   * Also ensures the sessions container exists (idempotent PUT).
   *
   * Spec: 3P.F.SessionList, 4Sol.S.TwinPodSessionIndex
   * @returns {Promise<void>}
   */
  async function loadIndex() {
    if (!_podRoot) return

    indexLoading.value = true
    indexLoadError.value = null

    // Ensure the sessions container exists before trying to read/write inside it.
    await ensureSessionsContainer()

    /**
     * Fetches an index.json from a given root URL.
     * Returns { entries, status } where entries is the parsed array (or null on miss)
     * and status is the HTTP status code (or 0 on network error).
     * Never throws — caller decides how to merge.
     */
    async function fetchIndex(rootUrl) {
      try {
        const response = await ur.hyperFetch(rootUrl + '/index.json', {
          method: 'GET',
          headers: { accept: 'application/json' }
        })
        if (response.ok) {
          const text = await response.text()
          try {
            const parsed = JSON.parse(text)
            if (Array.isArray(parsed)) return { entries: parsed, status: response.status }
          } catch {
            // Body wasn't JSON (e.g. TwinPod 200-not-404 returning Turtle for a missing
            // resource). Treat as absent.
          }
          return { entries: null, status: response.status }
        }
        return { entries: null, status: response.status }
      } catch {
        return { entries: null, status: 0 }
      }
    }

    try {
      // Read the canonical (new) index first.
      const primary = await fetchIndex(sessionsRoot())
      // Then read the legacy index (read-only, for migrating users with pre-rename data).
      const legacy = await fetchIndex(legacySessionsRoot())

      // Merge: new index entries win on id collision (a re-saved legacy session has
      // moved into the new index and should not appear twice).
      const merged = new Map()
      if (Array.isArray(legacy.entries)) {
        for (const entry of legacy.entries) {
          merged.set(entry.id, { ...entry, project: entry.project ?? 'The Brain' })
        }
      }
      if (Array.isArray(primary.entries)) {
        for (const entry of primary.entries) {
          merged.set(entry.id, { ...entry, project: entry.project ?? 'The Brain' })
        }
      }

      // Both sources missing AND both responded non-404 → treat as a real error.
      // Otherwise: 404 on either is just "first use" or "no legacy data" — fine.
      const primaryReal = primary.status !== 0 && primary.status !== 404
      const legacyReal = legacy.status !== 0 && legacy.status !== 404
      if (
        primary.entries === null && legacy.entries === null
        && (primaryReal || legacyReal)
      ) {
        indexLoadError.value = 'Could not load session index from TwinPod.'
        sessionList.value = []
        return
      }

      sessionList.value = Array.from(merged.values())
    } catch {
      indexLoadError.value = 'Could not load session index from TwinPod.'
      sessionList.value = []
    } finally {
      indexLoading.value = false
    }
  }

  // --- Write path ---

  /**
   * Writes the current sessionList to index.json on the pod.
   *
   * Uses ur.uploadFile to PUT JSON via the authenticated session.
   * Content-Type: application/json.
   *
   * Spec: 4Sol.S.TwinPodSessionIndex write path.
   * @returns {Promise<void>}
   */
  async function saveIndex() {
    if (!_podRoot) return

    const indexUrl = sessionsRoot() + '/index.json'
    const body = JSON.stringify(sessionList.value)

    const response = await ur.uploadFile(indexUrl, body, 'application/json')
    if (!response.ok) {
      sessionSaveError.value = `Could not save session index (HTTP ${response.status || 0}).`
    }
  }

  /**
   * Creates a new session entry, appends it to sessionList, saves the index,
   * and sets the new session as active.
   *
   * The new project gets a default name 'Project' (user can rename inline immediately).
   * project defaults to 'The Brain'.
   *
   * Spec: 3P.F.SessionCreate
   * @returns {Promise<void>}
   */
  async function createNewSession() {
    // Auto-save outgoing session if there are unsaved changes — mirrors switchToSession.
    if (isDirty.value && activeSessionId.value) {
      const currentName = sessionList.value.find(s => s.id === activeSessionId.value)?.name
        ?? 'Session'
      await saveCurrentSession(currentName)
    }

    // Auto-disambiguate the default name by appending a date+time stamp so
    // two rapid "New Project" clicks don't collide on the slug ('project').
    // Format: "Project YYYY-MM-DD HH:MM" → slug "project-YYYY-MM-DD-HH-MM".
    // If a caller later supplies an explicit user-typed name, this default
    // is replaced via renameSession — only the DEFAULT is timestamped.
    const timestamp = new Date().toISOString().slice(0, 16).replace('T', ' ')
    const name = `Project ${timestamp}`
    const id = generateSessionId(name)
    const lastModified = new Date().toISOString()

    const newEntry = { id, name, project: 'The Brain', lastModified }
    sessionList.value = [...sessionList.value, newEntry]

    // Set active and clear workspace BEFORE the network save (optimistic update).
    // This lets Vue re-render the panel immediately — the new session gets the
    // is-active highlight and the rename input appears without waiting for saveIndex().
    // onCreateNewSession in SessionPanel finds the session as soon as this returns.
    activeSessionId.value = id
    document.value = ''
    // Sync change-aware watcher baseline so the watcher does NOT treat this
    // programmatic clear as a user edit (Cycle 045 iter-2 change-aware autosave).
    _lastSavedContent = ''

    await saveIndex()
  }

  /**
   * Saves the current workbook content to {id}.md on the pod,
   * updates the index entry, and persists the index.
   *
   * isDirty is reset to false BEFORE the save to prevent double-save race:
   * if workbookContent changes again during the save, isDirty will be set
   * back to true by the watcher, triggering another autosave correctly.
   *
   * On failure: sets sessionSaveError; isDirty remains true so the next
   * autosave or explicit save retries.
   *
   * Spec: 3P.F.SessionSave, 4Sol.S.TwinPodSessionIndex
   * @param {string} name - Session name to persist in the index entry.
   * @returns {Promise<void>}
   */
  async function saveCurrentSession(name) {
    if (!_podRoot || !activeSessionId.value) return

    sessionSaving.value = true
    sessionSaveError.value = null

    // Reset isDirty BEFORE the save to prevent double-save race.
    // If content changes again during save, the watcher sets isDirty=true again.
    isDirty.value = false

    const id = activeSessionId.value
    // Spec: 4Sol.S.TwinPodSessionIndex (revised 2026-05-10) — session file is written
    // as a typed-JSON-document at {id}.json (extension matches the content honestly).
    // The legacy {id}.md file (if any) is NOT deleted on legacy → new conversion; it
    // remains as a historical artifact on the pod per spec "Old .md filename handling".
    const sessionFileUrl = sessionsRoot() + '/' + id + '.json'

    const project = sessionList.value.find(s => s.id === id)?.project ?? 'The Brain'
    const nowIso = new Date().toISOString()
    // Preserve created timestamp across saves (in-memory meta map). For sessions that
    // never had a stored created timestamp (new sessions in this build, or legacy
    // sessions migrated on this save), default to now() — this becomes the canonical
    // created on disk going forward.
    const existingMeta = _sessionMeta.get(id) ?? {}
    const created = existingMeta.created ?? nowIso

    // Block-id strategy: deterministic, stable per session.
    // For the bootstrap single-block case we use `${id}-block-1` so re-saves keep the
    // same block id. Future plugins that add/insert blocks should generate ids via
    // UUID v4 (or another collision-resistant scheme); the spec only requires stability
    // per block, not a specific format.
    // Guard C (Emergency 2026-05-14) — write a localStorage backup of the
    // workbook content BEFORE attempting the pod save. If the pod write
    // fails for any reason (network, auth, pay-gate redirect cancelling
    // the in-flight request) the draft is still recoverable at next boot.
    _writeLocalStorageBackup(id, document.value ?? '')

    const blockId = `${id}-block-1`
    const sessionDoc = {
      schemaVersion: DOC_SCHEMA_VERSION,
      id,
      name,
      project,
      created,
      lastModified: nowIso,
      blocks: [
        {
          id: blockId,
          kind: 'markdown_text',
          version: BLOCK_KINDS.markdown_text.version,
          text: document.value ?? ''
        }
      ]
    }
    const body = JSON.stringify(sessionDoc)

    // ──────────────────────────────────────────────────────────────────────────
    // Cycle 045 (iter-2, 2026-05-21) — bare-file PUT with transparent versioning.
    //
    // Per Kai's correction: session files are bare resources, not entity-bound
    // attributes. They have no parent entity holding a State pointer (e.g. a
    // schema:contentUrl predicate via Stack B PATCH), so the canonical 5-step
    // entity-update lifecycle (STATE_LIFECYCLE_01) does NOT apply to this save:
    //   - There is no rdfStore-tracked predicate whose old State must be deleted.
    //   - The file URL is stable (`{id}.json`) across saves, so TwinPod's
    //     transparent versioning (Reference_Code_TwinPod-EntityUpdateLifecycle
    //     Pattern 5) creates a new server-side version on each PUT to the same
    //     filename. No client-side State management is required.
    //
    // The previous Cycle 045 iter-1 implementation minted a Neo entity via
    // ur.createNeoNode and PATCHed a schema:contentUrl pointer via Stack B on
    // every save. That was over-engineered: the entity pointer URL never
    // changes (filename is stable), so re-PATCHing on every save is a no-op
    // that adds latency, log noise, and a failure mode.
    //
    // Net save path is one network call: a PUT of the JSON body. If empirical
    // testing later shows bare files DO need a parent-entity State pointer
    // (e.g. for cross-pod discovery or ACL), reintroduce the entity mint as a
    // one-time first-save step — not on every save.
    // ──────────────────────────────────────────────────────────────────────────

    try {
      const fileResponse = await ur.uploadFile(sessionFileUrl, body, 'application/json')
      if (!fileResponse.ok) {
        // Save failed — restore isDirty so retries happen.
        isDirty.value = true
        sessionSaveError.value = `Could not save session file (HTTP ${fileResponse.status || 0}).`
        return
      }

      // Successful save — update meta. Clear the legacy-loaded flag so future loads
      // skip the .md fallback once the new .json exists.
      _sessionMeta.set(id, { created, legacyLoaded: false })

      // Update the index entry (name + lastModified). entityURI is no longer
      // persisted — bare files don't need a parent-entity pointer.
      sessionList.value = sessionList.value.map(s =>
        s.id === id
          ? { ...s, name, lastModified: nowIso }
          : s
      )

      await saveIndex()

      // Remember what was saved so the change-aware autosave watcher can skip
      // reactive re-assignments that don't actually change content. Set BEFORE
      // clearing the local backup so a watcher-driven follow-up save sees the
      // up-to-date snapshot.
      _lastSavedContent = document.value ?? ''

      // Successful pod save — clear the localStorage backup so it does not
      // shadow future legitimate pod state (e.g. content edited on another
      // device). The backup is only valuable while it represents unsaved-
      // to-pod work.
      _clearLocalStorageBackup(id)
    } catch (err) {
      // Network failure — restore isDirty.
      isDirty.value = true
      sessionSaveError.value = 'Could not save session (network error).'
    } finally {
      sessionSaving.value = false
    }
  }

  /**
   * Fetches the session file for `id` and returns its markdown content as a string.
   *
   * Spec: 4Sol.S.TwinPodSessionIndex (revised 2026-05-10) — read path tries {id}.json
   * first (new typed-JSON-document shape). On 404, falls back to {id}.md, which may
   * hold either the legacy JSON-in-.md shape or the older text+YAML-frontmatter shape.
   * On legacy load, the legacy file is NOT rewritten; the user's next save persists
   * in the new .json shape (auto-convert at next save).
   *
   * For the bootstrap increment (TypedJSONDocSessionFormat) only the markdown text of
   * the first block is returned, so the workspace ref stays a plain string. Future
   * increments may return the full blocks array instead.
   *
   * Spec: 3P.F.SessionSwitch read path; 4Sol.S.TwinPodSessionIndex backward-compatibility.
   * @param {string} id - Session ID.
   * @returns {Promise<string>} Markdown content (legacy frontmatter stripped if present).
   */
  async function loadSession(id) {
    if (!_podRoot || !id) return ''

    // --- Try {id}.json first (new typed-JSON-document shape) ---
    const jsonUrl = sessionsRoot() + '/' + id + '.json'
    const jsonResponse = await ur.hyperFetch(jsonUrl, {
      method: 'GET',
      headers: { accept: 'application/json' }
    })

    if (jsonResponse.ok) {
      // MIME-negotiation gotcha (curated memory pod-json-read-write.md): in principle
      // ur.hyperFetch can return Turtle for a .json file if the server matches text/turtle
      // first. We send `accept: application/json` (mirrors loadIndex pattern, which works
      // empirically) and shape-check the parsed body below — non-JSON or non-matching
      // shape falls through to the .md fallback rather than crashing.
      const text = await jsonResponse.text()
      try {
        const parsed = JSON.parse(text)
        // New typed-JSON-document: has schemaVersion AND blocks array.
        if (typeof parsed.schemaVersion === 'number' && Array.isArray(parsed.blocks)) {
          _sessionMeta.set(id, { created: parsed.created, legacyLoaded: false })
          // Extract markdown from the first markdown_text block (bootstrap single-block).
          const firstMarkdown = parsed.blocks.find(b => b?.kind === 'markdown_text')
          return typeof firstMarkdown?.text === 'string' ? firstMarkdown.text : ''
        }
        // Body parsed but shape doesn't match new doc — treat as "no real saved session"
        // (matches the TwinPod 200-not-404 fabricated-response quirk).
        return ''
      } catch {
        // Body wasn't JSON at all (e.g. server returned Turtle despite the .json URL).
        // Fall through to the legacy .md path below.
      }
    } else if (jsonResponse.status !== 404) {
      // Real HTTP error on the .json GET — propagate.
      throw new Error(`Could not load session (HTTP ${jsonResponse.status}).`)
    }

    // --- Fallback chain: try {id}.md at the new path, then at the legacy path. ---
    //
    // The new container holds .md files only from a brief intermediate state during the
    // 2026-05 path renames; in production the .md files live at the legacy path. We try
    // the new container first (cheap, idempotent) then the legacy container so users
    // with pre-rename data still see their projects. Saves always go to the new path
    // — the legacy file remains as a historical artefact.
    async function tryLoadFromMdUrl(mdUrl) {
      const mdResponse = await ur.hyperFetch(mdUrl, {
        method: 'GET',
        headers: { accept: 'application/json' }
      })
      if (!mdResponse.ok) {
        return { found: false, status: mdResponse.status, content: '' }
      }
      const mdText = await mdResponse.text()
      // Legacy JSON-in-.md shape: { session_name, session_project, content }.
      try {
        const legacy = JSON.parse(mdText)
        if (typeof legacy?.content === 'string') {
          return { found: true, status: 200, content: legacy.content }
        }
      } catch {
        // Not JSON — fall through to text+frontmatter handling.
      }
      // Older legacy: text + YAML frontmatter. Strip frontmatter; body is markdown.
      const frontmatterRe = /^---\r?\n[\s\S]*?\r?\n---\r?\n\n?/
      return { found: true, status: 200, content: mdText.replace(frontmatterRe, '') }
    }

    // Try new path first.
    const newMdResult = await tryLoadFromMdUrl(sessionsRoot() + '/' + id + '.md')
    if (newMdResult.found) {
      _sessionMeta.set(id, { created: new Date().toISOString(), legacyLoaded: true })
      return newMdResult.content
    }
    if (newMdResult.status !== 404) {
      throw new Error(`Could not load session (HTTP ${newMdResult.status}).`)
    }

    // Try legacy path. Users with pre-rename data live here.
    const legacyMdResult = await tryLoadFromMdUrl(legacySessionsRoot() + '/' + id + '.md')
    if (legacyMdResult.found) {
      _sessionMeta.set(id, { created: new Date().toISOString(), legacyLoaded: true })
      return legacyMdResult.content
    }
    if (legacyMdResult.status !== 404) {
      throw new Error(`Could not load session (HTTP ${legacyMdResult.status}).`)
    }

    // Both new and legacy paths returned 404 → no session file anywhere → empty content.
    return ''
  }

  /**
   * Switches to a different session.
   *
   * If isDirty is true, auto-saves the current session before switching.
   * Fetches the incoming session's .md file and sets workbookContent.
   *
   * Spec: 3P.F.SessionSwitch
   * @param {string} id - Session ID to switch to.
   * @returns {Promise<void>}
   */
  async function switchToSession(id) {
    if (!id || id === activeSessionId.value) return

    // isSessionLoading drives the "Loading Project..." overlay in
    // WorkspacePane.vue. Set true for the duration of the switch (including
    // any autosave of the outgoing session) and reset in finally so a thrown
    // loadSession does not leave the overlay stuck. Boot-time restore also
    // routes through this method — showing the overlay during initial
    // restore is desirable UX, not a regression.
    isSessionLoading.value = true
    try {
      // Auto-save outgoing session if there are unsaved changes.
      if (isDirty.value && activeSessionId.value) {
        const currentName = sessionList.value.find(s => s.id === activeSessionId.value)?.name
          ?? 'Session'
        await saveCurrentSession(currentName)
      }

      // Set new active session.
      activeSessionId.value = id

      // Fetch incoming session content and populate the workspace.
      // isDirty must be false after this point — the loaded content is clean.
      try {
        const content = await loadSession(id)
        document.value = content
        // Sync change-aware watcher baseline so the load is not mistaken for a
        // user edit (Cycle 045 iter-2 change-aware autosave).
        _lastSavedContent = content ?? ''
        isDirty.value = false
      } catch (err) {
        sessionSaveError.value = 'Could not load session content.'
      }
    } finally {
      isSessionLoading.value = false
    }
  }

  // --- Rename helpers ---

  /**
   * Renames a session (updates name in index.json and in the session's .md frontmatter).
   *
   * Spec: 3P.F.SessionRename
   * @param {string} id - Session ID to rename.
   * @param {string} newName - New session name. Empty strings are rejected.
   * @returns {Promise<void>}
   */
  async function renameSession(id, newName) {
    const trimmed = newName.trim()
    if (!trimmed) return

    // Optimistic update — update UI immediately.
    sessionList.value = sessionList.value.map(s =>
      s.id === id ? { ...s, name: trimmed, lastModified: new Date().toISOString() } : s
    )

    // Persist updated index.
    await saveIndex()

    // Path 9 DROPPED (Cycle 046, 2026-05-23) — rename no longer GETs +
    // re-PUTs the session body to update its embedded `name` field. The
    // body's `session_name` becomes stale until the next autosave writes
    // it, which is acceptable: the panel shows the index entry's `name`
    // (authoritative), not the body's. Dropping the in-band body PATCH
    // removes the "rename drops in-flight edits" failure mode (rename
    // racing against a queued autosave of the body would clobber the
    // in-flight content).
  }

  /**
   * Changes the project label for a session.
   * Updates index.json only — no session file re-write needed.
   * This meets V.SessionProjectChangeability Goal (≤ 2 actions) because the
   * project label is stored separately from the session content.
   *
   * Spec: 3P.V.SessionProjectChangeability, 4Sol.S.TwinPodSessionIndex
   * @param {string} id - Session ID.
   * @param {string} newProject - New project label. Empty strings are rejected.
   * @returns {Promise<void>}
   */
  async function renameSessionProject(id, newProject) {
    const trimmed = newProject.trim()
    if (!trimmed) return

    // Optimistic update.
    sessionList.value = sessionList.value.map(s =>
      s.id === id ? { ...s, project: trimmed } : s
    )

    // Spec: 4Sol.S.TwinPodSessionIndex — only index.json is written on project label change.
    await saveIndex()
  }

  // --- Delete ---

  /**
   * Deletes a session: removes it from sessionList, saves the updated index,
   * and best-effort-deletes the session file from the pod.
   *
   * If the deleted session is the active one:
   *   - Switches to the most recently modified remaining session.
   *   - If no sessions remain, clears the workspace and sets activeSessionId to null.
   *
   * Optimistic update: sessionList is updated immediately so the UI reflects
   * the deletion before the network calls complete.
   *
   * Spec: 3P.F.SessionDelete
   * @param {string} id - Session ID to delete.
   * @returns {Promise<void>}
   */
  async function deleteSession(id) {
    if (!_podRoot) return

    const wasActive = activeSessionId.value === id

    // Optimistic update: remove from list immediately.
    sessionList.value = sessionList.value.filter(s => s.id !== id)

    if (wasActive) {
      if (sessionList.value.length > 0) {
        // Switch to the most recently modified remaining session.
        const mostRecent = [...sessionList.value].sort((a, b) =>
          b.lastModified.localeCompare(a.lastModified)
        )[0]
        activeSessionId.value = mostRecent.id
        try {
          const content = await loadSession(mostRecent.id)
          document.value = content
          // Sync change-aware watcher baseline (Cycle 045 iter-2).
          _lastSavedContent = content ?? ''
          isDirty.value = false
        } catch {
          document.value = ''
          _lastSavedContent = ''
          isDirty.value = false
        }
      } else {
        // No sessions left — clear workspace entirely.
        activeSessionId.value = null
        document.value = ''
        _lastSavedContent = ''
        isDirty.value = false
      }
    }

    // Persist the updated index.
    await saveIndex()

    // Best-effort: delete the session file(s) from the pod. We try BOTH the new
    // {id}.json (current write target) and the legacy {id}.md (historical artifact
    // that may still exist for sessions created before the typed-JSON-document
    // format). 404 / 405 / network errors on either are acceptable — the index has
    // already been updated and is the authoritative session list.
    const jsonUrl = sessionsRoot() + '/' + id + '.json'
    const mdUrl = sessionsRoot() + '/' + id + '.md'
    try {
      await ur.hyperFetch(jsonUrl, { method: 'DELETE' })
    } catch {
      // ignore
    }
    try {
      await ur.hyperFetch(mdUrl, { method: 'DELETE' })
    } catch {
      // ignore
    }
  }

  // --- Autosave ---

  /**
   * Sets up a debounced watcher on the shared document ref.
   * When isDirty is true and the debounce fires, calls saveCurrentSession().
   *
   * Replaces the single-workbook setupAutosave from usePodWorkbook.js for the
   * session-aware save path. App.vue calls this after loadIndex() resolves.
   * Do not call both setupAutosave (from usePodWorkbook) and setupSessionAutosave
   * in the same session — pick one. When sessions are active, use this one.
   *
   * @param {number} [debouncedMs=180000] - Debounce delay in ms. Default 3 minutes.
   *
   * Spec: 3P.F.SessionSave autosave trigger.
   */
  function setupSessionAutosave(debouncedMs = 180000) {
    // Change-aware watcher (Cycle 045 iter-2, 2026-05-21; updated Cycle 046
    // 2026-05-23 to route saves through the canonical background-save queue
    // per Reference_Code_TwinPod-OptimisticSaveQueue).
    //
    // The watcher gates on content equality (suppresses hydration / scroll-
    // restore re-assignments) and on debounce. When the debounce fires it
    // hands off to enqueueWorkbookSave, which enqueues via ur.enqueueSave
    // (FIFO-per-resourceKey). The queue is responsible for serialising
    // concurrent saves and surfacing status via useBackgroundSave /
    // <SaveStatusBadge />. The watcher does NOT call saveCurrentSession
    // directly any more — see enqueueWorkbookSave below.
    watch(document, (newDoc) => {
      const current = newDoc ?? ''
      if (current === _lastSavedContent) {
        // No real change — reactive re-assignment (load, hydration, etc.).
        // Do not flip isDirty, do not schedule a save.
        return
      }
      // Real content change — set isDirty so saveCurrentSession can reset it
      // before the write, and arm the debounce timer.
      isDirty.value = true

      clearTimeout(_autosaveTimer)
      _autosaveTimer = setTimeout(() => {
        _autosaveTimer = null
        if (!isDirty.value || !activeSessionId.value) return
        const name = sessionList.value.find(s => s.id === activeSessionId.value)?.name
          ?? 'Session'
        enqueueWorkbookSave(name)
      }, debouncedMs)
    }, { immediate: false })

    // Guard A REMOVED (Cycle 045, 2026-05-21) — save-on-first-edit watcher.
    //
    // The previous watch(isDirty, …) that fired saveCurrentSession on every
    // false→true transition of isDirty caused save-per-keystroke instead of
    // save-per-pause: saveCurrentSession resets isDirty to false before the
    // network write (see line ~604), so the very next keystroke flipped
    // isDirty false→true again and re-armed Guard A's 1s timer. With three
    // characters typed quickly, the result was 3× project-<id>.json PUT +
    // 3× index.json PUT in the network tab instead of the expected 1+1
    // after the change-aware debounce window.
    //
    // The change-aware debounce watcher above (watch(document, …)) is the
    // sole autosave trigger now: each keystroke clearTimeout()s the prior
    // _autosaveTimer and setTimeout()s a new one, so the save fires ONCE
    // after the user pauses for `debouncedMs`. Explicit saves (Save button,
    // session switch, ensureSessionSaved before redirect) remain unaffected
    // — they call saveCurrentSession / saveActiveSession directly and do
    // not depend on this watcher.
  }

  // --- Explicit save helper ---

  /**
   * Saves the currently active session, resolving the session name automatically
   * from sessionList. Designed for fire-and-forget callers (Projects button,
   * Download button) that do not manage session names directly.
   *
   * No-op when no session is active or when podRoot is not set.
   * @returns {Promise<void>}
   */
  async function saveActiveSession() {
    if (!activeSessionId.value || !_podRoot) return
    const name = sessionList.value.find(s => s.id === activeSessionId.value)?.name
      ?? 'Session'
    await saveCurrentSession(name)
  }

  // --- Canonical background-save entry points (Cycle 046, 2026-05-23) ---
  //
  // enqueueWorkbookSave + flushPendingSaves are the canonical entry points
  // for ALL workbook saves. They route through the background-save queue
  // (ur.enqueueSave) per Reference_Code_TwinPod-OptimisticSaveQueue —
  // serialised FIFO per resourceKey (the session JSON URL), with status
  // surfaced via useBackgroundSave + <SaveStatusBadge />.
  //
  // Existing callers (saveActiveSession, ensureSessionSaved, callers that
  // call saveCurrentSession directly) are wrapped to go through the queue
  // so all save paths share the same serialisation guarantee — no two
  // saves of the same session can race the 5-step lifecycle even in a
  // pathological click-storm.
  //
  // Trigger reduction (Cycle 046): the previous 11+ trigger paths
  // collapse to 3 canonical triggers (per Kai's 5-point design):
  //   1. Debounced typing — setupSessionAutosave watcher (above) ends in
  //      enqueueWorkbookSave on debounce fire.
  //   2. Lifecycle gate — beforeunload / switchToSession / createNewSession /
  //      wrappedLogout / wrappedStartCheckout call flushPendingSaves(timeoutMs).
  //      beforeunload uses timeoutMs=0 (snapshot to localStorage; no await).
  //   3. Explicit Save / workspace-pane click delegate → flushPendingSaves().

  /**
   * Canonical workbook-save entry point. Enqueues a save of the active
   * session through the background-save queue (ur.enqueueSave) and returns
   * the job id (or null when there is nothing to save). Synchronous return
   * — the actual write happens in the queue.
   *
   * The job's resourceKey is the session JSON URL. Saves of the same
   * session serialise FIFO; saves of different sessions can run in
   * parallel (which is fine — they target different resources).
   *
   * Guard C — the localStorage backup is written synchronously BEFORE the
   * queue enqueue, so even if the browser dies before the queue drains the
   * work is recoverable at next boot.
   *
   * @param {string} [name] - Session name to persist. Defaults to current
   *                          name from sessionList.
   * @returns {string | null} The queue job id, or null when no active session.
   */
  function enqueueWorkbookSave(name) {
    if (!_podRoot || !activeSessionId.value) return null
    const id = activeSessionId.value
    const sessionName = name
      ?? sessionList.value.find(s => s.id === id)?.name
      ?? 'Session'
    // Guard C — synchronous localStorage backup BEFORE enqueue. Survives
    // browser close even if the queued task never runs. saveCurrentSession
    // will also re-write the backup right before the network call, but
    // doing it here makes the close-while-queued window safe too.
    _writeLocalStorageBackup(id, document.value ?? '')
    const sessionFileUrl = sessionsRoot() + '/' + id + '.json'
    return ur.enqueueSave({
      resourceKey: sessionFileUrl,
      label: 'workbook-save',
      task: () => saveCurrentSession(sessionName)
    })
  }

  /**
   * Flush any pending debounce + await queue drain for the active session.
   * Canonical entry point for lifecycle gates (beforeunload, switchToSession,
   * createNewSession, wrappedLogout, wrappedStartCheckout, explicit Save
   * button, workspace-pane click delegate).
   *
   * Semantics:
   *   - Cancels any pending autosave debounce timer.
   *   - If document content differs from last-saved snapshot, enqueues a
   *     save synchronously (so beforeunload-snapshot work is captured in
   *     the localStorage backup even when timeoutMs=0).
   *   - Awaits queue drain for the active session up to timeoutMs.
   *   - timeoutMs=0 returns immediately AFTER the synchronous backup +
   *     enqueue — DO NOT await. This is the beforeunload contract: the
   *     browser will cancel in-flight fetches on unload anyway, so the
   *     localStorage backup (Guard C) is the recovery path.
   *
   * @param {number} [timeoutMs=3000] - Max ms to wait for the queue to drain
   *                                    after enqueueing the (optional) save.
   *                                    0 = synchronous-snapshot only.
   * @returns {Promise<boolean>} true on clean drain (or no-op), false on timeout.
   */
  async function flushPendingSaves(timeoutMs = 3000) {
    // 1. Cancel any pending debounce — about to flush.
    if (_autosaveTimer) {
      clearTimeout(_autosaveTimer)
      _autosaveTimer = null
    }
    // 2. Nothing to do when there is no active session / no podRoot.
    if (!_podRoot || !activeSessionId.value) return true
    // 3. Enqueue a save only when content actually differs from the last
    //    saved snapshot (avoids spurious PUTs on lifecycle transitions
    //    when the user did nothing). The dirty-flag is a hint that
    //    historically over-fired (see Guard A REMOVED comment); the
    //    content-comparison is the authoritative truth.
    const current = document.value ?? ''
    const needsSave = current !== _lastSavedContent
    let jobId = null
    if (needsSave) {
      jobId = enqueueWorkbookSave()
    }
    // 4. timeoutMs=0 — synchronous-snapshot mode (beforeunload). Backup
    //    was written inside enqueueWorkbookSave; queue task will run if
    //    the JS context survives long enough, otherwise localStorage is
    //    the recovery path. Return immediately without awaiting.
    if (timeoutMs === 0) return true
    // 5. Await drain. If we enqueued, wait for THIS job's terminal event.
    //    If we did NOT enqueue (no-op flush) but a prior autosave is in
    //    flight, watch for any in-flight task on our resourceKey and wait
    //    for its terminal event. Otherwise resolve immediately.
    const sessionFileUrl = sessionsRoot() + '/' + activeSessionId.value + '.json'
    return await new Promise((resolve) => {
      let settled = false
      let watchedJobId = jobId
      const overallTimer = setTimeout(() => {
        if (settled) return
        settled = true
        unsubscribe()
        resolve(false)
      }, timeoutMs)
      const settleWith = (ok) => {
        if (settled) return
        settled = true
        clearTimeout(overallTimer)
        unsubscribe()
        resolve(ok)
      }
      const unsubscribe = ur.onSaveEvent((evt) => {
        // Only events for our session resource matter.
        if (evt.resourceKey !== sessionFileUrl) return
        // If we did not enqueue and a prior autosave is still in flight,
        // adopt its id and wait for its terminal event.
        if (!watchedJobId && (evt.type === 'queued' || evt.type === 'started')) {
          watchedJobId = evt.id
          return
        }
        if (watchedJobId && evt.id === watchedJobId) {
          if (evt.type === 'succeeded') return settleWith(true)
          if (evt.type === 'failed') return settleWith(false)
        }
      })
      // No enqueue + no prior task expected: short-circuit immediately so
      // callers do not wait for the overallTimer on a clean state.
      if (!jobId) {
        // Yield a microtask so any in-flight `queued`/`started` for the
        // same key (e.g. enqueued moments before from another path) can
        // be observed before we settle clean.
        queueMicrotask(() => {
          if (!watchedJobId) settleWith(true)
        })
      }
    })
  }

  /**
   * Guard B (Emergency 2026-05-14) — pre-redirect save with timeout.
   *
   * Compatibility shim (Cycle 046, 2026-05-23) — delegates to
   * flushPendingSaves which is the canonical lifecycle-gate entry point.
   * Existing App.vue callers (wrappedLogout / wrappedStartCheckout) keep
   * working unchanged.
   *
   * @param {number} [timeoutMs=3000] - Max wait before yielding to the redirect.
   * @returns {Promise<boolean>} true on completed save or clean state; false on timeout/error.
   */
  async function ensureSessionSaved(timeoutMs = 3000) {
    try {
      return await flushPendingSaves(timeoutMs)
    } catch (e) {
      console.warn('[emergency-save] save before redirect failed', e)
      return false
    }
  }

  /**
   * Guard C-boot (Emergency 2026-05-14) — restore localStorage draft if newer.
   *
   * After loadSession populates the workspace from the pod, this helper
   * compares the pod-loaded content with any localStorage backup for the
   * same session id. If a backup exists AND its content differs from the
   * pod-loaded content, the backup is treated as the more-recent draft
   * (we cleared on every successful pod save, so any surviving backup
   * represents work that did NOT make it to the pod).
   *
   * On restore: writes the backup content into the document ref and
   * marks the session as dirty so the autosave triggers a fresh pod
   * save. Returns true when a restore happened so App.vue can show a
   * one-time toast.
   *
   * @param {string} sessionId - The active session id to check.
   * @returns {boolean} true when a draft was restored, false otherwise.
   */
  function restoreLocalStorageDraftIfNewer(sessionId) {
    if (!sessionId) return false
    const backup = _readLocalStorageBackup(sessionId)
    if (!backup) return false
    const podContent = document.value ?? ''
    if (backup.content === podContent) {
      // Pod is up to date — no restore needed.
      _clearLocalStorageBackup(sessionId)
      return false
    }
    // Backup differs from pod — restore it. The watch in setupSessionAutosave
    // will set isDirty=true and the new first-edit save (Guard A) will push
    // the restored content back to the pod within ~1s.
    document.value = backup.content
    return true
  }

  /**
   * Layer 2 boot restore (Emergency r2, 2026-05-14) — no-session scratch.
   *
   * Called by App.vue after `loadIndex()` resolves AND `sessionList` is
   * still empty (no sessions yet for this user). If a fresh (<24h)
   * scratch-draft entry exists in localStorage, restore its content into
   * `document` so the user does not lose work captured before a session
   * ever existed (the Buy-Credits-from-empty-workbook case).
   *
   * The Layer 1 auto-create watcher in App.vue will pick this up on the
   * user's next keystroke and promote the scratch into a real session;
   * we do NOT auto-create a session here so that returning users see
   * exactly the content they typed, with no surprise URL change.
   *
   * @returns {boolean} true when content was restored, false otherwise.
   */
  function restoreScratchDraftIfFresh() {
    const scratch = _readScratchDraft()
    if (!scratch) return false
    // Only restore when the workspace is empty — otherwise we would
    // shadow legitimately-loaded content from a different code path.
    if (document.value) return false
    document.value = scratch.content
    return true
  }

  // --- Pod root capture ---
  //
  // loadIndex() is called by App.vue with podRoot available via injection.
  // We capture podRoot here at call time so all methods can reference _podRoot.
  // The original loadIndex signature takes no arguments because podRoot is
  // injected into App.vue and provided via module-level _podRoot capture.
  // App.vue calls setPodRoot(podRoot.value) before loadIndex().

  /**
   * Records the resolved pod root URL.
   * Must be called by App.vue before loadIndex().
   * @param {string} podRoot - Pod root URL, no trailing slash.
   */
  function setPodRoot(podRoot) {
    _podRoot = podRoot ? podRoot.replace(/\/+$/, '') : ''
  }

  return {
    sessionList,
    activeSessionId,
    indexLoading,
    indexLoadError,
    sessionSaving,
    sessionSaveError,
    isSessionLoading,
    isDirty,
    setPodRoot,
    loadIndex,
    saveIndex,
    createNewSession,
    saveCurrentSession,
    saveActiveSession,
    loadSession,
    switchToSession,
    renameSession,
    renameSessionProject,
    deleteSession,
    setupSessionAutosave,
    // Emergency hotfix 2026-05-14 — data-loss defense-in-depth helpers.
    ensureSessionSaved,
    restoreLocalStorageDraftIfNewer,
    restoreScratchDraftIfFresh,
    // Canonical background-save entry points (Cycle 046, 2026-05-23).
    enqueueWorkbookSave,
    flushPendingSaves
  }
}
