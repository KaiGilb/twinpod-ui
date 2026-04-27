// UNIT_TYPE=Hook

/**
 * useSessionIndex
 *
 * Manages the session index for The Brain app: a JSON file at
 * {podRoot}/home/thebrain-sessions/index.json containing session metadata,
 * and individual session .md files at {podRoot}/home/thebrain-sessions/{id}.md.
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
 * SESSIONS_ROOT_PATH = '/home/thebrain-sessions'. Container creation is
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
import { ur } from '@kaigilb/twinpod-client'

// --- Single configurable constant for sessions storage root ---
//
// All path construction in this file uses this constant.
// No other file may hardcode this path string.
// Confirmed: pod /home/ surface supports subdirectory PUT (Cycle 12, LDP BasicContainer pattern).
// To use flat-file fallback, change this to '/home/thebrain-sessions' prefix and adjust
// _sessionsRoot() to return podRoot + SESSIONS_ROOT_PATH (no trailing slash) as a prefix
// rather than a directory.
const SESSIONS_ROOT_PATH = '/home/thebrain-sessions'

// Module-level state so App.vue and all injected children share the same reactive refs.
const sessionList = ref([])
const activeSessionId = ref(null)
const indexLoading = ref(false)
const indexLoadError = ref(null)
const sessionSaving = ref(false)
const sessionSaveError = ref(null)

// isDirty tracks unsaved changes in workbookContent.
// Set to true by watch on workbookContent after initial load.
// Reset to false before each saveCurrentSession() call (prevent double-save race).
const isDirty = ref(false)

// podRoot captured from App.vue provide context — set once at loadIndex() call time.
let _podRoot = ''

// Reference to the autosave debounce timer — held module-level so it can be cleared.
let _autosaveTimer = null

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
  isDirty.value = false
  _podRoot = ''
  _autosaveTimer = null
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
   * Ensures the sessions container exists on the pod using an LDP BasicContainer PUT.
   * Idempotent — 409 (already exists) is treated as success.
   * Uses the same pattern as Cycle 12 (usePodWorkbook.js container creation).
   * @returns {Promise<void>}
   */
  async function ensureSessionsContainer() {
    const containerUrl = sessionsRoot() + '/'
    await ur.hyperFetch(containerUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': 'text/turtle',
        'Link': '<http://www.w3.org/ns/ldp#BasicContainer>; rel="type"'
      },
      // rdfs:label gives the container a human-readable name in the pod browser.
      body: '@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .\n<> rdfs:label "TheBrainSessions" .\n'
    })
    // 409 = container already exists — acceptable; we do not check the response status here
    // because the PUT of the workbook file immediately after will surface auth failures.
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

    const indexUrl = sessionsRoot() + '/index.json'

    try {
      // Use ur.hyperFetch with Accept: application/json for plain JSON reads.
      // This routes through the authenticated session (single-namespace rule).
      const response = await ur.hyperFetch(indexUrl, {
        method: 'GET',
        headers: { accept: 'application/json' }
      })

      if (response.ok) {
        const text = await response.text()
        const parsed = JSON.parse(text)
        // Backward compat: older entries missing the project field default to 'The Brain'.
        sessionList.value = parsed.map(entry => ({
          ...entry,
          project: entry.project ?? 'The Brain'
        }))
        return
      }

      if (response.status === 404) {
        // First use — no index.json yet. Treat as empty list, no error.
        sessionList.value = []
        return
      }

      // Any other non-ok status is a real error.
      indexLoadError.value = 'Could not load session index from TwinPod.'
      sessionList.value = []
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
   * The new session gets a default name 'New Session — YYYY-MM-DD'.
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

    const today = new Date().toISOString().slice(0, 10)   // 'YYYY-MM-DD'
    const name = `New Session — ${today}`
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
    const sessionFileUrl = sessionsRoot() + '/' + id + '.md'

    // Store the session as a JSON object so the pod serves it back as application/json.
    // text/markdown caused a MIME negotiation failure: the pod returned Turtle on GET
    // because it does not recognise text/markdown as a supported content type.
    // application/json is confirmed to work — the index.json follows the same pattern.
    // Spec: 4Sol.S.TwinPodSessionIndex — session file contains session_name, session_project, content.
    const project = sessionList.value.find(s => s.id === id)?.project ?? 'The Brain'
    const sessionData = {
      session_name: name,
      session_project: project,
      content: document.value ?? ''
    }
    const body = JSON.stringify(sessionData)

    try {
      const fileResponse = await ur.uploadFile(sessionFileUrl, body, 'application/json')
      if (!fileResponse.ok) {
        // Save failed — restore isDirty so retries happen.
        isDirty.value = true
        sessionSaveError.value = `Could not save session file (HTTP ${fileResponse.status || 0}).`
        return
      }

      // Update the index entry.
      const lastModified = new Date().toISOString()
      sessionList.value = sessionList.value.map(s =>
        s.id === id ? { ...s, name, lastModified } : s
      )

      await saveIndex()
    } catch (err) {
      // Network failure — restore isDirty.
      isDirty.value = true
      sessionSaveError.value = 'Could not save session (network error).'
    } finally {
      sessionSaving.value = false
    }
  }

  /**
   * Fetches the .md file for a session and returns its content as a string.
   * Strips frontmatter before returning so the workspace shows clean content.
   *
   * Spec: 3P.F.SessionSwitch read path.
   * @param {string} id - Session ID.
   * @returns {Promise<string>} Raw markdown content (frontmatter stripped).
   */
  async function loadSession(id) {
    if (!_podRoot || !id) return ''

    const sessionFileUrl = sessionsRoot() + '/' + id + '.md'

    const response = await ur.hyperFetch(sessionFileUrl, {
      method: 'GET',
      headers: { accept: 'application/json' }
    })

    if (!response.ok) {
      // 404 = session file not saved yet — return empty content.
      if (response.status === 404) return ''
      throw new Error(`Could not load session (HTTP ${response.status}).`)
    }

    const text = await response.text()

    // New format (application/json): extract the content field.
    // Old format (text/markdown with YAML frontmatter): strip frontmatter and return raw text.
    // The try/catch handles the transition: sessions saved before the JSON format
    // change fall through to the frontmatter-strip path.
    try {
      const parsed = JSON.parse(text)
      if (typeof parsed.content === 'string') {
        return parsed.content
      }
    } catch {
      // Not JSON — fall through to old-format handling.
    }

    // Old format fallback: strip YAML frontmatter if present.
    const frontmatterRe = /^---\r?\n[\s\S]*?\r?\n---\r?\n\n?/
    return text.replace(frontmatterRe, '')
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
      isDirty.value = false
    } catch (err) {
      sessionSaveError.value = 'Could not load session content.'
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

    // Also update the session file if it exists.
    // Best-effort: if the file doesn't exist yet, ignore the 404.
    // On next saveCurrentSession() the new name will be written.
    const sessionFileUrl = sessionsRoot() + '/' + id + '.md'
    const fileResponse = await ur.hyperFetch(sessionFileUrl, {
      method: 'GET',
      headers: { accept: 'application/json' }
    })

    if (fileResponse.ok) {
      const existingText = await fileResponse.text()
      try {
        // New JSON format: parse, update session_name, write back.
        const existing = JSON.parse(existingText)
        existing.session_name = trimmed
        await ur.uploadFile(sessionFileUrl, JSON.stringify(existing), 'application/json')
      } catch {
        // Not JSON (old text/markdown format or unexpected content).
        // No-op — the updated name is already in index.json; the session file
        // will be rewritten as JSON on the next saveCurrentSession().
      }
    }
    // 404 = file not yet saved; session_name will be written on next saveCurrentSession().
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
          isDirty.value = false
        } catch {
          document.value = ''
          isDirty.value = false
        }
      } else {
        // No sessions left — clear workspace entirely.
        activeSessionId.value = null
        document.value = ''
        isDirty.value = false
      }
    }

    // Persist the updated index.
    await saveIndex()

    // Best-effort: delete the session file from the pod.
    // No-op if the file was never content-saved (404) or if DELETE is not supported (405).
    const sessionFileUrl = sessionsRoot() + '/' + id + '.md'
    try {
      await ur.hyperFetch(sessionFileUrl, { method: 'DELETE' })
    } catch {
      // Network error or method not allowed — acceptable; index is already updated.
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
    watch(document, () => {
      // { immediate: false } is not needed on watch — the watcher only fires on change.
      // isDirty is set true here; saveCurrentSession will reset it before saving.
      isDirty.value = true

      clearTimeout(_autosaveTimer)
      _autosaveTimer = setTimeout(() => {
        if (!isDirty.value || !activeSessionId.value) return
        const name = sessionList.value.find(s => s.id === activeSessionId.value)?.name
          ?? 'Session'
        saveCurrentSession(name)
      }, debouncedMs)
    }, { immediate: false })
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
    setupSessionAutosave
  }
}
