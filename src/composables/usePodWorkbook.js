// UNIT_TYPE=Hook

/**
 * usePodWorkbook
 *
 * Manages read and write of the workbook Markdown file on the user's TwinPod pod.
 *
 * Storage path: {podRoot}/home/TomTwin/thebrain-workbook.md
 *
 * Read path (Evo2):
 *   On load success: sets the module-level document ref (from useWorkspace) to the
 *   fetched Markdown string so WorkspacePane.vue renders it immediately.
 *   On 404: treats the file as absent; sets document to '' (empty workbook — no error shown).
 *   On other errors: sets loadError with a human-readable message; document stays ''.
 *
 * Write path (Evo3):
 *   saveWorkbook() issues an authenticated PUT to {podRoot}/home/TomTwin/thebrain-workbook.md
 *   with Content-Type: text/plain and body = current document content.
 *   On success: updates lastSaved with an ISO timestamp.
 *   On failure: sets saveError with a human-readable message (non-blocking — no modal).
 *   setupAutosave(debouncedMs) watches the shared document ref and calls saveWorkbook()
 *   after the debounce delay on every substantive edit.
 *
 * @returns {{
 *   workspaceContent: import('vue').Ref<string>,
 *   loadWorkbook:     (podRoot: string) => Promise<void>,
 *   loadError:        import('vue').Ref<string|null>,
 *   isLoading:        import('vue').Ref<boolean>,
 *   saveWorkbook:     () => Promise<void>,
 *   saveError:        import('vue').Ref<string|null>,
 *   lastSaved:        import('vue').Ref<string|null>,
 *   setupAutosave:    (debouncedMs?: number) => void
 * }}
 *
 * Preconditions:
 *   - window.solid.session must be set to the authenticated session before calling loadWorkbook()
 *     or saveWorkbook(). App.vue bridges session to window.solid.session in Evo1.
 *   - podRoot must be a non-empty string (e.g. 'https://user.demo.systemtwin.com').
 *   - setupAutosave() must be called only once, after loadWorkbook() resolves, to avoid
 *     triggering a spurious save on the initial document population.
 *
 * Errors:
 *   - loadError.value is null on success or 404.
 *   - loadError.value is a string message on any other fetch failure.
 *   - saveError.value is null on success.
 *   - saveError.value is a string message on PUT failure (displayed inline, non-blocking).
 *
 * Spec: F.WorkbookPodLoad, F.WorkbookPodSave
 * V.PodLoadLatency    — Goal: workbook visible within 2s of login; Tolerable: 5s
 * V.SessionPickupFluency — Goal: workbook from prior session visible within 10s; Tolerable: 30s
 * V.PodSaveLatency    — Goal: PUT response within 2s of debounce; Tolerable: 5s
 * V.WorkbookOwnershipClarity — 100% of saves target Kai's pod URL only
 *
 * @example
 * const { workspaceContent, loadWorkbook, saveWorkbook, setupAutosave } = usePodWorkbook()
 * await loadWorkbook(podRoot)
 * setupAutosave()
 */

import { ref, watch } from 'vue'
import { ur } from '@kaigilb/twinpod-client'
import { useWorkspace } from './useWorkspace.js'

// Shared workspaceContent ref — exposed to App.vue for loading/error display
// and wired to the module-level document ref from useWorkspace so WorkspacePane
// renders pod content without any prop threading.
const workspaceContent = ref('')
const loadError = ref(null)
const isLoading = ref(false)

// Save state — module-level so WorkspacePane.vue can inject and display status
// without prop threading.
const saveError = ref(null)
const lastSaved = ref(null)   // ISO timestamp string set after each successful PUT

// podRoot captured on first loadWorkbook() call; reused by saveWorkbook() and
// setupAutosave(). Stored module-level so saveWorkbook() needs no arguments.
let _podRoot = ''

export function usePodWorkbook() {
  // Access the module-level document ref from useWorkspace so this composable
  // can seed it on load. WorkspacePane.vue already binds to this same ref via
  // its own useWorkspace() call — no prop changes needed.
  const { document } = useWorkspace()

  /**
   * Fetches the workbook Markdown from {podRoot}/home/TomTwin/thebrain-workbook.md.
   *
   * Uses ur.fetchResourceTurtle — the lightweight resource reader that fetches
   * the raw bytes without the hypergraph header. For a plain .md file TwinPod
   * returns the file content directly in the turtle field.
   *
   * 404 → treated as empty workbook (no error shown to user).
   * Other failures → loadError set; document stays empty.
   *
   * @param {string} podRoot - Pod root URL, no trailing slash.
   *   e.g. 'https://user.demo.systemtwin.com'
   *
   * Spec: F.WorkbookPodLoad
   */
  async function loadWorkbook(podRoot) {
    if (!podRoot) return

    // Capture podRoot for saveWorkbook() — must be set before any save attempt.
    _podRoot = podRoot

    isLoading.value = true
    loadError.value = null

    // Ensure the TomTwin container exists before attempting to read or write
    // the workbook inside it. PUT with LDP BasicContainer Link header is
    // idempotent — returns 2xx if created, 409 if already exists; both are fine.
    const containerUrl = podRoot + '/home/TomTwin/'
    await ur.hyperFetch(containerUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': 'text/turtle',
        'Link': '<http://www.w3.org/ns/ldp#BasicContainer>; rel="type"'
      },
      // rdfs:label maps to m_label in TwinPod (neo predicate registry).
      // Gives the container a human-readable name in the pod browser.
      body: '@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .\n<> rdfs:label "TomTwin" .\n'
    })

    // --- Spec: V.PodLoadLatency — measure time from call to content ready ---
    const url = podRoot + '/home/TomTwin/thebrain-workbook.md'

    try {
      // ur.hyperFetch with Accept: text/markdown — hyperFetch only sets the
      // accept header when not already provided, so this overrides the default
      // Turtle-biased chain and tells the server to return raw Markdown content.
      const response = await ur.hyperFetch(url, {
        method: 'GET',
        headers: { accept: 'text/markdown' }
      })

      if (response.ok) {
        // Spec: F.WorkbookPodLoad — on success, set workspaceContent to the
        // fetched markdown string and propagate to the shared document ref.
        const content = await response.text()
        workspaceContent.value = content
        document.value = content
        return
      }

      if (response.status === 404) {
        // Spec: F.WorkbookPodLoad — 404 means the workbook file does not exist yet.
        // Treat as empty workbook — no error shown, no console error.
        workspaceContent.value = ''
        document.value = ''
        return
      }

      // Any other non-ok status is a real error — show a message.
      workspaceContent.value = ''
      loadError.value = 'Could not load workbook from TwinPod.'
    } catch {
      // Network failure or unexpected throw from ur.hyperFetch.
      workspaceContent.value = ''
      loadError.value = 'Could not load workbook from TwinPod.'
    } finally {
      isLoading.value = false
    }
  }

  /**
   * Saves the current workbook content to {podRoot}/home/TomTwin/thebrain-workbook.md
   * via an authenticated PUT.
   *
   * Write mechanism: ur.uploadFile — plain Markdown PUT (not Turtle PATCH) routed
   * through ur.hyperFetch (authenticated). Content-Type: text/plain per S.TwinPodFileRW.
   * ur.uploadFile does not throw on network failure — it returns { ok: false, status: 0 }.
   *
   * On success: sets lastSaved to the current ISO timestamp.
   * On failure: sets saveError with a human-readable message (non-blocking).
   *
   * Spec: F.WorkbookPodSave
   * V.PodSaveLatency — Tolerable: 5000ms; Goal: 2000ms (measure via DevTools Network)
   * V.WorkbookOwnershipClarity — write target is always {_podRoot}/home/TomTwin/thebrain-workbook.md
   *
   * @returns {Promise<void>}
   */
  async function saveWorkbook() {
    // Guard: cannot save if pod root was never resolved (not yet logged in).
    if (!_podRoot) return

    // --- Spec: V.WorkbookOwnershipClarity — write target is Kai's pod only ---
    const url = _podRoot + '/home/TomTwin/thebrain-workbook.md'

    // ur.uploadFile routes through ur.hyperFetch (authenticated; single-namespace rule).
    // Content-Type: text/markdown (RFC 7763) — correct MIME type for .md files.
    const response = await ur.uploadFile(url, document.value, 'text/markdown')

    if (response.ok) {
      // Spec: F.WorkbookPodSave — on success, record the save timestamp.
      lastSaved.value = new Date().toISOString()
      saveError.value = null
      return
    }

    // Non-ok response — surface as a non-blocking inline error.
    saveError.value = `Could not save workbook (HTTP ${response.status || 0}).`
  }

  /**
   * Sets up a debounced autosave watcher on the shared document ref.
   *
   * Must be called exactly once, after loadWorkbook() resolves, so the initial
   * document population does not trigger a spurious save.
   *
   * The watcher fires saveWorkbook() after debouncedMs of inactivity — the timer
   * resets on every keystroke so rapid edits produce only one network request.
   *
   * @param {number} [debouncedMs=30000] - Debounce delay in milliseconds.
   *   Default 30000ms (30s) — saves at most once per quiet period, not on every keystroke.
   *
   * Spec: F.WorkbookPodSave — "save triggered on every substantive workspace edit (debounced)"
   */
  function setupAutosave(debouncedMs = 30000) {
    let debounceTimer = null

    // Watch the shared document ref (same one WorkspacePane.vue binds to).
    // On every change: clear the pending timer and restart it. Only the final
    // change after a quiet period fires saveWorkbook().
    watch(document, () => {
      clearTimeout(debounceTimer)
      debounceTimer = setTimeout(saveWorkbook, debouncedMs)
    })
  }

  return {
    workspaceContent,
    loadWorkbook,
    loadError,
    isLoading,
    saveWorkbook,
    saveError,
    lastSaved,
    setupAutosave
  }
}
