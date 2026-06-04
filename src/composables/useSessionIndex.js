// UNIT_TYPE=Hook

/**
 * useSessionIndex
 *
 * Manages the projects for The Brain app, stored on the user's TwinPod pod
 * under {podRoot}/home/TomTwinProjects/.
 *
 * SELF-CONTAINED PROJECT FOLDER (Gen-3, Cycle 066-extended, 2026-06-03)
 * ---------------------------------------------------------------------
 * Each project is ONE self-contained folder at {podRoot}/home/TomTwinProjects/<id>/
 * holding EVERYTHING for that project, so the folder can later be moved/shared as
 * a unit (the portable/shared-pod future). The folder contains:
 *   - content.json  — the typed-JSON-document (schemaVersion + blocks[]); the
 *                      project's editable content. Stable filename so a consumer
 *                      finds it without external knowledge.
 *   - manifest.json  — the project's own identity metadata (id, name, project,
 *                      created, lastModified, schemaVersion, owner placeholder).
 *                      Sufficient to reconstruct the catalog entry WITHOUT the
 *                      user's index.json — copy <id>/ to another pod and the
 *                      receiver reads the manifest to rebuild the entry.
 *   - <file>         — the project's uploaded attachments (already nested here
 *                      since Cycle 066 by the app's useDocumentUpload).
 *
 * The manifest is the source of truth for a project's IDENTITY. index.json is
 * DEMOTED to a derived catalog (fast list render) — see rebuildIndexFromManifests
 * which regenerates it by scanning the folders' manifests.
 *
 * Manifest design decision (separate manifest.json + content.json, not a single
 * project.json with an embedded meta block): a small manifest makes the catalog
 * rebuild fast — rebuild reads one tiny file per project instead of parsing each
 * project's full (potentially large, attachment-referencing) content document.
 * Clean separation of identity-metadata from editable-content also keeps the
 * portable unit's "what is this project" answer cheap to read on a receiving pod.
 *
 * BACKWARD-COMPATIBLE TRI-GENERATIONAL READ (binding, no regression):
 *   - Gen-3 (new): {podRoot}/home/TomTwinProjects/<id>/ (manifest + content inside).
 *   - Gen-2 (prior production): loose {podRoot}/home/TomTwinProjects/<id>.json content
 *     + {podRoot}/home/TomTwinProjects/<id>/ attachments + entry in index.json.
 *   - Gen-1 (legacy): {podRoot}/home/TomTwinProjects/<id>.md (or older) +
 *     {podRoot}/home/thebrain-sessions/index.json.
 *   Every old project (Gen-1 and Gen-2) still lists AND opens; old attachments at
 *   BOTH the pre-066 home/<slug>/ path and the Cycle-066 TomTwinProjects/<id>/ path
 *   stay reachable. loadSession resolves in the order above (shape-checked).
 *
 * LAZY-MIGRATE-ON-SAVE (no eager bulk move): a Gen-1/Gen-2 project is persisted in
 * the Gen-3 self-contained shape on its NEXT save (saveCurrentSession always writes
 * <id>/content.json + <id>/manifest.json). Old loose files are left in place as
 * historical artefacts (the established "old .md/.json filename handling" pattern).
 * There is no migrate-everything-at-once code path.
 *
 * Storage path is governed by the single module-level constant SESSIONS_ROOT_PATH.
 * Changing the projects storage location means editing one line — no other file
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
 * Container pre-creation: strict-LDP pods (tst-planlegger.twinpod.eu, tst-solveig)
 * return 409 when a PUT targets a path whose immediate parent container does not exist.
 * _ensureContainer (HEAD-first, text/turtle PUT, NO Slug) creates TomTwinProjects/ and
 * each <id>/ folder before the first file write. Guards (_rootContainerEnsured,
 * _projectContainersEnsured) prevent redundant round-trips per session. Lenient pods
 * (demo.systemtwin.com) auto-materialise containers on write; the guards make the
 * extra HEAD effectively free after the first check.
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
 *   isSavingProject:      import('vue').Ref<boolean>,
 *   isDirty:              import('vue').Ref<boolean>,
 *   loadIndex:            () => Promise<void>,
 *   saveIndex:            () => Promise<void>,
 *   rebuildIndexFromManifests: () => Promise<Array>,
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
//
// EXPORTED (Cycle 066) so consumers that must write SIBLING resources under the
// same projects root — e.g. the app's useDocumentUpload attachment path — derive
// the root from this single constant rather than hardcoding a second copy. Honors
// 4Sol.S.TwinPodProjectIndex: "No other file may hardcode this path — all
// references go through SESSIONS_ROOT_PATH", so changing the location is one edit.
export const SESSIONS_ROOT_PATH = '/home/TomTwinProjects'

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

// --- Gen-3 self-contained project shape (Cycle 066-extended, 2026-06-03) ---
//
// A project's self-contained folder holds two stable-named JSON files:
//   <id>/content.json  — { schemaVersion, id, blocks[] }    (the editable content)
//   <id>/manifest.json — { schemaVersion, id, name, project, created,
//                          lastModified, owner }            (identity metadata)
//
// CONTENT_FILENAME / MANIFEST_FILENAME are stable + predictable so a consumer on
// a receiving pod finds them without external knowledge (criterion 1).
const CONTENT_FILENAME = 'content.json'
const MANIFEST_FILENAME = 'manifest.json'

// Manifest schema version — independent of the content document's schemaVersion.
// Bump only when the manifest's own shape changes.
const MANIFEST_SCHEMA_VERSION = 1

// owner is a RESERVED provenance/owner placeholder for the future portable/shared-pod
// direction. Cycle 066-extended ships the self-contained STRUCTURE only — the
// New-Direction Gate for "shared pods / multiple users" was OVERRIDDEN by Kai for
// STRUCTURE, but the multi-user value hierarchy was NOT run, so NO sharing / ACL /
// permission / ownership-transfer LOGIC is built. This field is written as null and
// is never read to make an access decision. A receiving pod may later populate it.
const MANIFEST_OWNER_PLACEHOLDER = null

// CONTAINER PRE-CREATION FOR STRICT LDP PODS (Cycle 066-extended rev4, 2026-06-04)
// ---------------------------------------------------------------------------------
// tst-planlegger.twinpod.eu and tst-solveig.twinpod.eu are strict LDP pods: they
// return 409 Conflict when a PUT targets a path whose IMMEDIATE parent container
// does not yet exist — even if the grandparent exists. Auto-materialization (writing
// one level into an existing container) only works on lenient pods such as
// demo.systemtwin.com.
//
// The fix is _ensureContainer — a best-effort HEAD-first guard that creates the
// container with a text/turtle PUT if it is missing. No Slug header is added:
//
//   ⚠  PUT to containerUrl/ WITH Slug: X creates a CHILD container INSIDE
//      containerUrl/ named X — NOT the container AT containerUrl/. Adding Slug
//      when PUTting TO a URL was the root cause of the prior doubling bug that
//      created /home/TomTwinProjects/TomTwinProjects/ (commit dce9ccf).
//
// Correct invocation — NO Slug, PUT goes TO the target URL, WITH the captured
// label body so the container gets a CLEAN display name (no leading comma):
//   PUT {root}/TomTwinProjects/  text/turtle  body `<> rdfs:label "TomTwinProjects" .`
//   PUT {root}/TomTwinProjects/<id>/  text/turtle  body `<> rdfs:label "<display-name>" .`
//
// AUTHORITATIVE RECIPE (supersedes the earlier "label body silently dropped
// post-2026-05-30" belief): the live wire-capture of the production Accelerator
// (twinpod.eu/app, 2026-06-03 — Reference_Code_TwinPod-AcceleratorWireMap.md
// § "Create a folder (container)") shows the trailing-slash text/turtle PUT with
// body `<> rdfs:label "<Name>" .` returning 200 with the label PERSISTING and a
// clean name in the tree. The leading-comma symptom appears only when a container
// has NO label triple. The earlier "silently dropped" diagnosis was app-auth /
// wrong-verb confusion and is corrected here and in
// Reference_Code_TwinPod-DefaultContainers-quirks.md.
//
// Write-order still applies as belt-and-suspenders (lenient pods get the auto-
// materialisation path; strict pods get the pre-created container):
//   Step 1: _ensureContainer(TomTwinProjects/, "TomTwinProjects") → exists or created.
//   Step 2: saveIndex() writes index.json → no-op on the container.
//   Step 3: _ensureContainer(<id>/, <display-name>) → exists or created.
//   Step 4: saveCurrentSession writes manifest.json BEFORE content.json.

// Module-level state so App.vue and all injected children share the same reactive refs.
const sessionList = ref([])
const activeSessionId = ref(null)
const indexLoading = ref(false)
const indexLoadError = ref(null)
// indexLoaded — true once loadIndex() has run to completion (success OR a clean
// "first use" empty), false until then. The login-clobber guard (Cycle 067 P0
// regression fix, 2026-06-04): App.vue's Layer 1 auto-create-session must NEVER
// fire before this is true, because firing while sessionList is still its boot-
// time empty [] would write a single-entry index.json over the user's real
// catalog. A bare `sessionList.length === 0` check is NOT sufficient — the list
// is also empty DURING the load window before hydration. Gating auto-create on
// `indexLoaded === true && sessionList.length === 0` distinguishes "genuinely a
// new user" from "index not loaded yet". Reset by _resetModuleStateForTesting.
const indexLoaded = ref(false)
const sessionSaving = ref(false)
const sessionSaveError = ref(null)
// Non-blocking error surface for delete failures (BareFileSave 2026-05-23).
// Previously deleteSession swallowed all errors silently; we now route through
// ur.deleteURI and surface failures here so the UI / telemetry can see them
// without blocking the optimistic list removal.
const sessionDeleteError = ref(null)

// isSessionLoading drives the "Loading Project..." overlay in
// WorkspacePane.vue. Set true while switchToSession() is in flight
// (including any autosave of the outgoing session) and reset in a
// finally block so a thrown loadSession does not leave it stuck.
const isSessionLoading = ref(false)

// isSavingProject drives the "Saving Project..." overlay in
// WorkspacePane.vue — the sibling of isSessionLoading for the NEW-project
// save path. The first save of a brand-new project takes 8+ seconds (the
// index.json PUT, plus a name PUT when the project is created via the name
// modal), during which the user previously had zero feedback. This flag is
// toggled by App.vue's create-project wrappers (createNewSessionWithUrlSync
// / createNewProjectWithName) in a try/finally so it spans the FULL
// operation (create + optional rename + route push), not just the bare
// createNewSession() index write. It is deliberately NOT toggled inside
// createNewSession() itself, and is NOT touched by the debounced autosave
// path (enqueueWorkbookSave / flushPendingSaves) — so the full-pane overlay
// never flashes during normal typing of an already-open project.
const isSavingProject = ref(false)

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

// _freshSessions: IDs minted by createNewSession() this session but not yet
// persisted to content.json. syncManifestIfMigrated() skips the probe for
// these — content.json does not exist yet so the GET would always 404,
// logging a spurious network error in the browser console.
// Cleared for each id on the first successful content.json write in
// saveCurrentSession(). Cleared in full by _resetModuleStateForTesting().
//
// IMPORTANT: this Set is NOT _sessionMeta. _sessionMeta means "loaded this
// session"; a loaded-not-opened Gen-3 project is absent from _sessionMeta
// but legitimately needs the syncManifestIfMigrated probe. _freshSessions
// only marks "created-this-session, never written to pod".
const _freshSessions = new Set()

// MODULE-LEVEL: authenticated session fetch, captured via setSessionFetch().
// Required for HEAD and PUT calls in _ensureContainer. Null until App.vue
// calls setSessionFetch(session.fetch.bind(session)) after auth resolves.
// _ensureContainer early-returns (no-op) when this is null, so tests that
// do not wire a fetch still pass.
let _sessionFetch = null

// MODULE-LEVEL: guard flags to prevent redundant HEAD + PUT round-trips.
//
// _rootContainerEnsured — true once TomTwinProjects/ has been confirmed or
// created this session. The root container does not disappear mid-session.
// Reset by _resetModuleStateForTesting().
let _rootContainerEnsured = false

// _projectContainersEnsured — Set of project IDs whose <id>/ container has
// been confirmed or created. Projects do not disappear mid-session.
// Reset by _resetModuleStateForTesting().
const _projectContainersEnsured = new Set()

/**
 * Best-effort HEAD-first container pre-creation for strict LDP pods.
 *
 * TwinPod™ pods on tst-planlegger.twinpod.eu and tst-solveig.twinpod.eu return
 * 409 Conflict when a PUT targets a path whose immediate parent container does not
 * yet exist — even if the grandparent exists. This guard creates the container before
 * any file write so strict-pod saves succeed.
 *
 * CRITICAL — NO Slug header: PUT to containerUrl/ without a Slug creates the container
 * AT that URL (standard LDP PUT semantics). Adding a Slug header would create a CHILD
 * container INSIDE the URL, not at it — that is what caused the doubling bug in dce9ccf.
 * // NO Slug header — Slug on PUT creates a child INSIDE the container, not AT the URL.
 *
 * Body = the AUTHORITATIVE captured wire recipe `<> rdfs:label "<Name>" .` (text/turtle).
 * This is what gives the container its clean display name and eliminates the leading
 * comma the LaunchPad renders for an unlabeled container. Source: live wire-capture of
 * the production Accelerator (twinpod.eu/app, 2026-06-03) — see
 * Reference_Code_TwinPod-AcceleratorWireMap.md § "Create a folder (container)":
 *   PUT <pod>/home/<Name>/  Content-Type: text/turtle  body: <> rdfs:label "<Name>" .  → 200
 * This SUPERSEDES the earlier "rdfs:label body silently dropped post-2026-05-30" claim
 * (that diagnosis was app-auth / wrong-verb confusion); the live app-authorized capture
 * proves the label body persists with a clean name in the tree.
 *
 * @param {string} containerUrl - URL of the container to ensure (must end with /).
 * @param {Function} authenticatedFetch - DPoP-authenticated session.fetch.
 * @param {string} label - rdfs:label literal written into the container's Turtle body
 *   (the friendly display name shown in the LaunchPad tree). Quotes are escaped.
 * @returns {Promise<boolean>} true when the container exists or was successfully
 *   created; false when the container could not be confirmed or created (guard
 *   must NOT be set in that case — the next save should retry).
 */
async function _ensureContainer(containerUrl, authenticatedFetch, label) {
  if (!authenticatedFetch) return true // no fetch wired — treat as "ok to proceed"
  try {
    const head = await authenticatedFetch(containerUrl, { method: 'HEAD' })
    if (head.ok) return true   // already exists — no PUT needed
    if (head.status !== 404) return false // unexpected status — don't attempt create
    // Captured wire body — the bare `<> rdfs:label "<Name>" .` triple. No @prefix line
    // (rdfs: is a server-recognized default), matching the production Accelerator capture.
    const safeLabel = String(label ?? '').replace(/"/g, '\\"')
    const put = await authenticatedFetch(containerUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': 'text/turtle',
        'Link': '<http://www.w3.org/ns/ldp#BasicContainer>; rel="type"'
        // NO Slug header — Slug on PUT creates a child INSIDE the container, not AT the URL.
      },
      body: `<> rdfs:label "${safeLabel}" .` // captured Accelerator recipe — sets the clean container name
    })
    // Return true only if PUT succeeded (2xx). A failed PUT means the container may
    // not exist; caller must not cache the guard as "done" — retry on next save.
    return put.ok
  } catch (e) {
    // Best-effort: log and continue. On a lenient pod the file PUT auto-materialises
    // the container anyway; on a strict pod the subsequent file PUT may 409 (surfaced
    // by saveIndex / saveCurrentSession error handling).
    console.warn('[useSessionIndex] _ensureContainer failed (best-effort):', containerUrl, e)
    return false
  }
}

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
  indexLoaded.value = false
  sessionSaving.value = false
  sessionSaveError.value = null
  sessionDeleteError.value = null
  isSessionLoading.value = false
  isSavingProject.value = false
  isDirty.value = false
  _podRoot = ''
  _autosaveTimer = null
  _lastSavedContent = ''
  _sessionMeta.clear()
  _freshSessions.clear()
  _sessionFetch = null
  _rootContainerEnsured = false
  _projectContainersEnsured.clear()
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

  // --- Per-project path helpers (Cycle 066-extended) ---
  //
  // ALL per-project URL construction goes through these four helpers — no path
  // string is rebuilt inline. This is load-bearing for the background-save queue:
  // enqueueWorkbookSave, switchToSession's post-restore enqueue, flushPendingSaves'
  // drain-watch, saveCurrentSession, and deleteSession must all compute the SAME
  // resourceKey, or a flush would never observe its save's terminal event. The
  // queue resourceKey is the Gen-3 contentUrl(id) — the file actually written.

  /** Gen-3 self-contained folder URL for a project: {root}/<id>/ (trailing slash). */
  function folderUrl(id) {
    return sessionsRoot() + '/' + id + '/'
  }

  /** Gen-3 content document URL: {root}/<id>/content.json. */
  function contentUrl(id) {
    return folderUrl(id) + CONTENT_FILENAME
  }

  /** Gen-3 manifest URL: {root}/<id>/manifest.json. */
  function manifestUrl(id) {
    return folderUrl(id) + MANIFEST_FILENAME
  }

  /** Gen-2 (legacy) loose content URL at the new container root: {root}/<id>.json. */
  function looseJsonUrl(id) {
    return sessionsRoot() + '/' + id + '.json'
  }

  /**
   * Re-writes a project's in-folder manifest.json with the CURRENT name/project
   * from sessionList — but ONLY for an already-migrated (Gen-3) project (one whose
   * <id>/content.json already exists). For an un-migrated Gen-2/Gen-1 project there
   * is no folder yet, so we skip: its next content-save migrates it with the correct
   * name (lazy-migrate). This keeps the manifest the source of truth for identity
   * (criterion 1) — a renamed Gen-3 project's portable folder carries the new name
   * even if the content is never re-edited.
   *
   * SAFE against the rename-race that made Cycle 046 drop the body re-PUT: the
   * manifest holds NO content `blocks`, so re-PUTting it cannot clobber an in-flight
   * content edit. It is pure identity metadata.
   *
   * Best-effort + non-blocking: a failure surfaces on sessionSaveError but does not
   * throw (the index.json write already captured the rename for the live UI).
   * @param {string} id - Session ID.
   * @returns {Promise<void>}
   */
  async function syncManifestIfMigrated(id) {
    if (!_podRoot || !id) return
    // Brand-new sessions (created this session, never persisted to content.json)
    // are skipped entirely — the probe GET would always 404, logging a spurious
    // browser console error. The content.json does not exist until the first
    // saveCurrentSession() call, which also clears the id from _freshSessions.
    if (_freshSessions.has(id)) return
    // Only sync when the project is already Gen-3 (content.json exists). Shape-check
    // guards the TwinPod™ 200-not-404 quirk: a fabricated 200 without our shape is
    // treated as "not migrated yet".
    let migrated = false
    let contentCreated // authoritative `created` from the already-migrated content doc.
    try {
      const probe = await ur.hyperFetch(contentUrl(id), {
        method: 'GET',
        headers: { accept: 'application/json' }
      })
      if (probe.ok) {
        try {
          const p = JSON.parse(await probe.text())
          migrated = typeof p.schemaVersion === 'number' && Array.isArray(p.blocks)
          if (migrated && typeof p.created === 'string') contentCreated = p.created
        } catch { migrated = false }
      }
    } catch { return } // network blip — leave the manifest for the next content save.
    if (!migrated) return

    const entry = sessionList.value.find(s => s.id === id)
    if (!entry) return
    // `created` is preserved, NOT regenerated. Prefer the content doc's created
    // (authoritative, just read above) so a rename-from-list of a project NOT opened
    // this session does not overwrite the manifest's created with now() —
    // `_sessionMeta` is only seeded by loadSession/saveCurrentSession, never loadIndex,
    // and `entry.lastModified` was just set to now() by the optimistic rename update.
    const created = contentCreated ?? _sessionMeta.get(id)?.created ?? entry.lastModified ?? new Date().toISOString()
    const manifest = {
      schemaVersion: MANIFEST_SCHEMA_VERSION,
      id,
      name: entry.name,
      project: entry.project ?? 'The Brain',
      created,
      lastModified: entry.lastModified ?? new Date().toISOString(),
      owner: MANIFEST_OWNER_PLACEHOLDER
    }
    const res = await ur.uploadFile(manifestUrl(id), JSON.stringify(manifest), 'application/json')
    if (!res.ok) {
      sessionSaveError.value = `Renamed, but could not update the project manifest (HTTP ${res.status || 0}).`
    }
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
   * Does NOT pre-create the container: it auto-materializes on the first save
   * (write-path-only idiom, Cycle 066). A missing container reads as "first use".
   *
   * Spec: 3P.F.SessionList, 4Sol.S.TwinPodSessionIndex
   * @returns {Promise<void>}
   */
  async function loadIndex() {
    if (!_podRoot) return

    indexLoading.value = true
    indexLoadError.value = null

    // No pre-create step needed for the read path: a missing container reads as
    // "first use" (primary index 404/empty) below. Write-order discipline handles
    // container materialization on the first saveIndex() write in createNewSession.

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

      // Cycle 048 fix (2026-05-24) — eliminate the per-login legacy `index.json`
      // 404 (or wasted round-trip) for migrated users by only reading the legacy
      // path when the primary returned nothing. After a user has triggered any
      // saveIndex() post-rename, the primary contains the full merged list
      // (including formerly-legacy entries) and a second legacy fetch only
      // produces network noise (a 404 in the most common case, since the
      // legacy `index.json` is never deleted but is never re-written either —
      // it stays as a historical artefact). The merge semantics ("primary wins
      // on id collision") become a no-op the moment primary holds the full set.
      //
      // Pre-migration users (primary genuinely empty/404) still get the legacy
      // fallback so their existing data surfaces unchanged. Eager write-up of
      // legacy into primary is deferred — landing it here would introduce a
      // pod write on every cold load for the duration of the migration, which
      // is a separate decision from the network-noise fix.
      const legacy = primary.entries === null
        ? await fetchIndex(legacySessionsRoot())
        : { entries: null, status: 0 }

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

      // Both sources missing AND primary responded with a real error (5xx,
      // network failure) → surface as a load error. Otherwise: 404 on either
      // is just "first use" or "no legacy data" — fine. (The legacy fetch is
      // only consulted when primary === null, so a legacy real-error need
      // not be checked separately — primary already supplied null.)
      const primaryReal = primary.status !== 0 && primary.status !== 404
      const legacyReal = legacy.status !== 0 && legacy.status !== 404
      if (
        primary.entries === null && legacy.entries === null
        && (primaryReal || legacyReal)
      ) {
        indexLoadError.value = 'Could not load session index from TwinPod.'
        sessionList.value = []
        // indexLoaded stays false — a real load error is NOT a confirmed
        // "first use" empty. App.vue's auto-create guard keys on indexLoaded,
        // so leaving it false here prevents an auto-create from clobbering a
        // catalog that merely failed to read (transient 5xx / network blip).
        return
      }

      // SELF-HEALING RECOVERY (Cycle 067 P0 regression fix, 2026-06-04).
      //
      // The Cycle-066 guarantee is that each project's in-folder manifest.json is
      // the SOURCE OF TRUTH for its identity and index.json is a DERIVED catalog.
      // Apply that on the read path: scan the per-project Gen-3 folders and UNION
      // any manifest whose id is NOT already in `merged` into the catalog. This
      // recovers a user whose index.json was lost / emptied / PARTIALLY clobbered
      // — e.g. tst-jack, whose index.json was overwritten with a single spurious
      // empty entry while N real project folders survived — on their very next
      // login, with NO data loss.
      //
      // Why union-always, not only-when-empty: the observed clobber writes a
      // ONE-entry index.json (createNewSession appends to the boot-empty list then
      // PUTs it), so the realistic damaged state is `[1 spurious entry]` — NOT
      // empty. Gating recovery on "merged is empty" would never fire for that
      // state and tst-jack would stay broken. Unioning every login covers
      // missing / empty / partial uniformly (the brief's 3b "missing/partial/
      // empty" requirement).
      //
      // Conflict rule: an EXISTING index entry WINS over a manifest for the same id
      // (the index carries the live name/lastModified the UI just rendered); only
      // manifest-only ids are added. So a healthy login is unchanged except for
      // additive recovery — the union can never shrink or rename a correctly-loaded
      // project. Genuinely-new users (no folders) get an empty scan → no fabricated
      // entries. The scan is READ-ONLY; the recovered catalog is persisted by the
      // next save (or by an explicit saveIndex), not written here.
      //
      // Cost: one ur.listContainer + N manifest GETs per login. Acceptable for a
      // P0 data-recovery; a future optimisation could write-back the unioned index
      // once so steady-state logins skip the scan.
      try {
        const rebuilt = await rebuildIndexFromManifests()
        if (Array.isArray(rebuilt)) {
          let recovered = 0
          for (const entry of rebuilt) {
            if (!merged.has(entry.id)) {
              merged.set(entry.id, { ...entry, project: entry.project ?? 'The Brain' })
              recovered++
            }
          }
          if (recovered > 0) {
            console.info(
              `[useSessionIndex] recovered ${recovered} project(s) from per-folder manifests not present in index.json (self-healing derived-catalog union).`
            )
          }
        }
      } catch (e) {
        // Best-effort recovery — a failed scan leaves the index-derived list as-is.
        console.warn('[useSessionIndex] self-healing manifest union failed (best-effort):', e)
      }

      sessionList.value = Array.from(merged.values())
      // A clean load (success or confirmed first-use empty) — auto-create may
      // now run safely. Set LAST so it is only true once sessionList holds the
      // authoritative (possibly rebuilt) catalog.
      indexLoaded.value = true
    } catch {
      indexLoadError.value = 'Could not load session index from TwinPod.'
      sessionList.value = []
      // indexLoaded stays false on a thrown error — see the early-return note.
    } finally {
      indexLoading.value = false
    }
  }

  // --- Write path ---

  /**
   * Writes the current sessionList to index.json on the pod.
   *
   * DERIVED CATALOG (Cycle 066-extended): index.json is no longer the source of
   * truth for a project's identity — each project's in-folder manifest.json is.
   * index.json is still written on every save as a fast list-render cache (and the
   * dual-read/merge backward-compat path depends on it), but a lost/corrupt
   * index.json can be regenerated from the per-folder manifests via
   * rebuildIndexFromManifests().
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
   * Rebuilds the project catalog by scanning the self-contained project folders'
   * manifests — the recovery path for a lost/missing/corrupt index.json
   * (criterion 2). Proves the manifest, not index.json, is the source of truth for
   * a project's identity: each Gen-3 folder reconstructs its own catalog entry.
   *
   * Algorithm:
   *   1. ur.listContainer({root}/) → child URIs. LDP marks containers (folders)
   *      with a trailing slash; loose files ({id}.json, {id}.md, index.json) do not.
   *      We keep only the trailing-slash children = the per-project Gen-3 folders.
   *   2. For each folder, GET <folder>manifest.json and shape-check it (id string +
   *      created string + NO blocks — distinguishes a manifest from a content doc
   *      under the TwinPod 200-not-404 quirk).
   *   3. Reconstruct the catalog entry { id, name, project, lastModified } from the
   *      manifest. De-dupe on id (a folder's manifest wins; defensive only — one
   *      folder per id).
   *
   * Scope/limitation (documented, not silent): manifest-rebuild recovers ONLY
   * migrated Gen-3 projects (they alone have a manifest). Un-migrated Gen-2 loose
   * {id}.json and Gen-1 {id}.md projects have no manifest and are NOT recovered by
   * this scan — they still rely on a present index.json (the normal path) and
   * lazy-migrate into Gen-3 on their next save. This is acceptable: rebuild is a
   * recovery path, and index.json is written on every save.
   *
   * Does NOT overwrite sessionList or write index.json itself — it RETURNS the
   * reconstructed entries so the caller decides what to do (inspect, then optionally
   * assign to sessionList + saveIndex()). This keeps a pure, testable rebuild.
   *
   * Spec: 4Sol.S.TwinPodProjectIndex — index.json is a derived catalog rebuildable
   * from the per-folder manifests.
   * @returns {Promise<Array<{id:string,name:string,project:string,lastModified:string}>>}
   */
  async function rebuildIndexFromManifests() {
    if (!_podRoot) return []

    const rootUrl = sessionsRoot() + '/'
    let children = []
    try {
      children = await ur.listContainer(rootUrl)
    } catch {
      // Container missing / unreadable → nothing to rebuild from.
      return []
    }

    // Keep only sub-CONTAINERS (trailing slash per LDP) — the per-project folders.
    const folderUrls = (children || []).filter(u => typeof u === 'string' && u.endsWith('/'))

    const byId = new Map()
    for (const folder of folderUrls) {
      const mUrl = folder + MANIFEST_FILENAME
      let response
      try {
        response = await ur.hyperFetch(mUrl, {
          method: 'GET',
          headers: { accept: 'application/json' }
        })
      } catch {
        continue // network blip on one folder — skip it, keep scanning the rest.
      }
      if (!response || !response.ok) continue
      let parsed
      try {
        parsed = JSON.parse(await response.text())
      } catch {
        continue // Turtle-for-.json / non-JSON body → not a manifest.
      }
      // Manifest shape: id (string) + created (string) AND NO blocks array — the
      // latter distinguishes a manifest from a content doc returned by a fabricated
      // 200 (TwinPod 200-not-404 quirk).
      const isManifest =
        typeof parsed.id === 'string' &&
        typeof parsed.created === 'string' &&
        !Array.isArray(parsed.blocks)
      if (!isManifest) continue

      byId.set(parsed.id, {
        id: parsed.id,
        name: typeof parsed.name === 'string' ? parsed.name : parsed.id,
        project: typeof parsed.project === 'string' ? parsed.project : 'The Brain',
        lastModified: typeof parsed.lastModified === 'string'
          ? parsed.lastModified
          : (parsed.created ?? new Date().toISOString())
      })
    }

    return Array.from(byId.values())
  }

  /**
   * Builds the seed body for a brand-new project: a single `# <name>` heading
   * line so the project name is visible at the top of the document the moment it
   * is created (3P.F.SessionCreate — name-shown-at-top, Kai 2026-06-04). An
   * optional `extra` body (the scratch-promotion path's captured keystrokes) is
   * appended below the heading so a "type-to-create" promotion never loses the
   * user's first words.
   *
   * The heading line is recognised verbatim on later rename (see
   * SEED_HEADING_RE) so a rename can update it in place without leaving a stale
   * or duplicate name line (rename-safety, criterion 3).
   *
   * @param {string} name - The project's display name.
   * @param {string} [extra] - Optional existing body to preserve below the heading.
   * @returns {string}
   */
  function buildSeedBody(name, extra = '') {
    const heading = `# ${name}`
    const body = String(extra ?? '')
    return body ? `${heading}\n\n${body}` : `${heading}\n\n`
  }

  /**
   * Rename-safety helper (criterion 3): rewrites a seeded `# <oldName>` heading
   * on the FIRST line of `body` to `# <newName>`, in place, WITHOUT adding a
   * second name line. Returns null when the first line is NOT exactly the
   * machine-seeded heading for `oldName` — i.e. the user edited or removed it, or
   * the project predates seeding — in which case the caller must leave the body
   * untouched (never append a duplicate name line).
   *
   * Matching is exact against the seed shape `# <oldName>` so we only ever touch
   * the line WE wrote; any user edit to that line (different text, extra words)
   * fails the match and is preserved verbatim.
   *
   * @param {string} body - Current document body.
   * @param {string} oldName - The name the heading was seeded with.
   * @param {string} newName - The new project name.
   * @returns {string|null} Rewritten body, or null if no seeded heading to update.
   */
  function rewriteSeededHeading(body, oldName, newName) {
    const text = String(body ?? '')
    const nlIdx = text.indexOf('\n')
    const firstLine = nlIdx === -1 ? text : text.slice(0, nlIdx)
    if (firstLine !== `# ${oldName}`) return null // not our seeded heading — leave it.
    const rest = nlIdx === -1 ? '' : text.slice(nlIdx)
    return `# ${newName}${rest}`
  }

  /**
   * Creates a new session entry, appends it to sessionList, sets it active, and
   * — Cycle 067, 2026-06-04 — persists the project to the pod IMMEDIATELY:
   * folder + manifest.json + content.json are written on create with NO user
   * action required (3P.F.SessionCreate immediate-persist goal). Previously
   * createNewSession only wrote index.json; the project folder/files were not
   * written until a later lifecycle event (e.g. navigating away and back). The
   * create path now calls saveCurrentSession() directly, which writes
   * manifest.json → content.json → index.json in the container-ensured,
   * idempotent order. Stable per-id URLs keep the write idempotent (no pod
   * litter — a re-created/abandoned project writes to the same three resources).
   *
   * The document is seeded with a `# <name>` heading (buildSeedBody) so the
   * project name is visible at the top immediately.
   *
   * @param {Object} [opts]
   * @param {string} [opts.name] - Explicit project name (name-modal path). When
   *   omitted, a disambiguated default "Project YYYY-MM-DD HH:MM" is used. Passing
   *   the final name here means the name-modal path needs NO separate renameSession
   *   call — the name lands in the single create-time write, so there is no
   *   transient stale heading and no second content PUT.
   * @param {string} [opts.seedBody] - Optional existing body (scratch-promotion
   *   captured keystrokes) preserved below the seeded heading.
   * @returns {Promise<void>}
   *
   * Spec: 3P.F.SessionCreate
   */
  async function createNewSession(opts = {}) {
    // Auto-save outgoing session if there are unsaved changes — mirrors switchToSession.
    // Cycle 046: route through flushPendingSaves so the save runs through the queue
    // (serialised against any in-flight autosave on the outgoing session).
    if (isDirty.value && activeSessionId.value) {
      await flushPendingSaves(3000)
    }

    // Name resolution: an explicit name (name-modal path) lands in the single
    // create-time write so no separate rename is needed. Otherwise auto-
    // disambiguate the default with a date+time stamp so two rapid "New Project"
    // clicks don't collide on the slug ('project').
    // Format: "Project YYYY-MM-DD HH:MM" → slug "project-YYYY-MM-DD-HH-MM".
    const explicitName = String(opts.name ?? '').trim()
    const timestamp = new Date().toISOString().slice(0, 16).replace('T', ' ')
    const name = explicitName || `Project ${timestamp}`
    const id = generateSessionId(name)
    const lastModified = new Date().toISOString()

    // Mark as fresh — content.json has not been written yet. saveCurrentSession()
    // (called below) clears this on its first successful content.json write. If the
    // immediate create-save FAILS, the id stays fresh so a follow-up rename does not
    // probe a content.json that isn't there yet (avoids a spurious console 404).
    _freshSessions.add(id)

    const newEntry = { id, name, project: 'The Brain', lastModified }
    sessionList.value = [...sessionList.value, newEntry]

    // Set active and seed the workspace with the name heading BEFORE the network
    // save (optimistic update). This lets Vue re-render the panel immediately and
    // shows the project name at the top of the new document. Sync the change-aware
    // watcher baseline to the seeded body so the autosave watcher does NOT treat
    // this programmatic seed as a user edit (Cycle 045 iter-2 change-aware autosave).
    activeSessionId.value = id
    const seeded = buildSeedBody(name, opts.seedBody)
    document.value = seeded
    _lastSavedContent = seeded

    // Immediate persist (Cycle 067): write the project's folder + manifest.json +
    // content.json to the pod NOW via saveCurrentSession — which also writes
    // index.json and clears the id from _freshSessions on success. This replaces
    // the prior saveIndex()-only create path; we do NOT call saveIndex() as well
    // (saveCurrentSession calls it internally). The container-ensure for
    // TomTwinProjects/ and <id>/ happens inside saveCurrentSession.
    await saveCurrentSession(name)
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
    // Gen-3 self-contained shape (Cycle 066-extended): the project's content is
    // written to {root}/<id>/content.json and its identity metadata to
    // {root}/<id>/manifest.json — both INSIDE the project's own folder. This is the
    // ALWAYS-write target, so it doubles as lazy-migrate-on-save: a Gen-1/Gen-2
    // project saved here lands in the Gen-3 shape with NO special migration branch.
    // The legacy loose {id}.json / {id}.md files (if any) are NOT deleted — they
    // remain as historical artefacts per the established "old filename handling".
    const sessionFileUrl = contentUrl(id)
    const sessionManifestUrl = manifestUrl(id)

    // Rename-race fix (Cycle 047, 2026-05-23): resolve `name` from sessionList
    // at PUT-time rather than trusting the `name` parameter captured at enqueue
    // time. The background-save queue can hold a `saveCurrentSession("Old Name")`
    // task that was enqueued before a renameSession() call updated sessionList;
    // if we used the stale parameter, the body file AND the post-success
    // sessionList .map below would both overwrite the user's new name with
    // the old one (the "rename pops back" bug — Hypothesis 5 in the brief).
    // sessionList is the authoritative source for `name` — renameSession writes
    // it, saveCurrentSession reads it. The parameter is only a fallback for the
    // unlikely case where the entry was removed between enqueue and PUT.
    const resolvedName = sessionList.value.find(s => s.id === id)?.name ?? name
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
    // content.json — the typed-JSON-document. Shape is unchanged from the prior
    // loose {id}.json (schemaVersion + blocks, plus the mirrored identity fields)
    // so it is a drop-in for the Gen-2 file and the existing loadSession shape-check
    // (schemaVersion number + blocks array) works on it verbatim.
    const sessionDoc = {
      schemaVersion: DOC_SCHEMA_VERSION,
      id,
      name: resolvedName,
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

    // manifest.json — the project's IDENTITY metadata, sufficient to reconstruct
    // this project's index.json catalog entry WITHOUT the user's index.json
    // (criterion 1 + 2). Includes `project` (the grouping label) because the
    // catalog entry is { id, name, project, lastModified } — omitting it would make
    // a rebuilt entry invalid. `owner` is the reserved provenance placeholder
    // (null, no logic — New-Direction-Gate structure-only boundary).
    const manifest = {
      schemaVersion: MANIFEST_SCHEMA_VERSION,
      id,
      name: resolvedName,
      project,
      created,
      lastModified: nowIso,
      owner: MANIFEST_OWNER_PLACEHOLDER
    }
    const manifestBody = JSON.stringify(manifest)

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
      // --- Ensure containers exist before writing ---
      //
      // On strict-LDP pods (tst-planlegger, tst-solveig) a PUT to a path whose
      // immediate parent container does not yet exist returns 409. We ensure both
      // TomTwinProjects/ (the root) and TomTwinProjects/<id>/ (the project folder)
      // exist before writing any files.
      //
      // Guard semantics: _rootContainerEnsured prevents re-checking TomTwinProjects/
      // more than once per session. _projectContainersEnsured prevents re-checking
      // the same project folder more than once. Both are best-effort — a failed
      // _ensureContainer is logged and does not throw; the subsequent file PUT may
      // still succeed on lenient pods where auto-materialisation covers the gap.
      if (!_rootContainerEnsured) {
        // Label = "TomTwinProjects" — the clean parent-container display name.
        const ok = await _ensureContainer(sessionsRoot() + '/', _sessionFetch, 'TomTwinProjects')
        if (ok) _rootContainerEnsured = true
      }
      if (!_projectContainersEnsured.has(id)) {
        // Label = the project's friendly display name (resolvedName), NOT the id slug.
        // The path stays the stable <id> (portable); only the tree label is the human
        // name (e.g. "Sanskrit"). resolvedName is read from sessionList above.
        const ok = await _ensureContainer(folderUrl(id), _sessionFetch, resolvedName)
        if (ok) _projectContainersEnsured.add(id)
      }

      // Write manifest.json BEFORE content.json (belt-and-suspenders write order).
      // On lenient pods without _ensureContainer the manifest PUT auto-materialises
      // <id>/; on strict pods the _ensureContainer above already created it.
      //
      // Failure semantics: manifest failure is non-fatal (surfaced, isDirty NOT
      // restored — the content write has not happened yet, so retrying saves both).
      // Content failure restores isDirty so the autosave re-queues.
      const manifestResponse = await ur.uploadFile(sessionManifestUrl, manifestBody, 'application/json')
      if (!manifestResponse.ok) {
        // Non-fatal: log and continue. content.json write still proceeds.
        // The next save will re-PUT the manifest alongside the content.
        sessionSaveError.value = `Could not save project manifest (HTTP ${manifestResponse.status || 0}). Will retry on next save.`
      }

      const fileResponse = await ur.uploadFile(sessionFileUrl, body, 'application/json')
      if (!fileResponse.ok) {
        // Save failed — restore isDirty so retries happen.
        isDirty.value = true
        sessionSaveError.value = `Could not save session file (HTTP ${fileResponse.status || 0}).`
        return
      }

      // content.json is now on the pod — the session is no longer "fresh".
      // syncManifestIfMigrated() will probe on the NEXT rename (e.g. user renames
      // an existing project from the list) and correctly finds content.json.
      _freshSessions.delete(id)

      // Successful save — update meta. Clear the legacy-loaded flag so future loads
      // resolve from the Gen-3 folder rather than the legacy loose-file fallback.
      _sessionMeta.set(id, { created, legacyLoaded: false })

      // Update the index entry — lastModified only. `name` is owned by
      // renameSession (the index entry IS the authoritative name source); we
      // must NOT overwrite it here, or a saveCurrentSession enqueued before a
      // rename would clobber the new name when its PUT resolves (Cycle 047
      // rename-race fix). entityURI is no longer persisted — bare files don't
      // need a parent-entity pointer.
      sessionList.value = sessionList.value.map(s =>
        s.id === id
          ? { ...s, lastModified: nowIso }
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
   * Fetches the project's content for `id` and returns its markdown text as a string.
   *
   * TRI-GENERATIONAL READ (Cycle 066-extended) — resolves in this order, shape-checked
   * at each step (binding, no regression — every old project must still open):
   *   1. Gen-3: {root}/<id>/content.json  (self-contained folder — the new shape)
   *   2. Gen-2: loose {root}/<id>.json    (prior production typed-JSON-document)
   *   3. Gen-1: {root}/<id>.md            (new container, brief intermediate state)
   *   4. Gen-1: legacy {legacyRoot}/<id>.md (pre-Cycle-021 production location)
   * Old files are never rewritten on read; the user's next save persists in the Gen-3
   * shape (lazy-migrate-on-save). The .md shapes carry the legacy JSON-in-.md or
   * text+YAML-frontmatter body.
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

    // Reads a typed-JSON-document content file (Gen-3 content.json or Gen-2 loose
    // {id}.json — identical shape). Returns one of:
    //   { kind: 'hit',     text }    — shape matched; this is the content.
    //   { kind: 'miss' }              — 404, or a 200 whose body is not a content doc
    //                                   (TwinPod 200-not-404 / Turtle-for-.json quirk).
    //                                   Caller falls through to the next generation.
    //   throws                        — a real (non-404) HTTP error.
    // MIME-negotiation gotcha (curated memory pod-json-read-write.md): hyperFetch can
    // return Turtle for a .json URL; we send `accept: application/json` (mirrors
    // loadIndex, which works empirically) and shape-check before trusting the body.
    async function tryLoadContentJson(url) {
      const response = await ur.hyperFetch(url, {
        method: 'GET',
        headers: { accept: 'application/json' }
      })
      if (response.ok) {
        const text = await response.text()
        try {
          const parsed = JSON.parse(text)
          // Content document shape: schemaVersion (number) AND blocks (array).
          if (typeof parsed.schemaVersion === 'number' && Array.isArray(parsed.blocks)) {
            _sessionMeta.set(id, { created: parsed.created, legacyLoaded: false })
            const firstMarkdown = parsed.blocks.find(b => b?.kind === 'markdown_text')
            return { kind: 'hit', text: typeof firstMarkdown?.text === 'string' ? firstMarkdown.text : '' }
          }
          // Parsed but not a content doc (fabricated 200 / different shape) → miss.
          return { kind: 'miss' }
        } catch {
          // Body wasn't JSON (e.g. Turtle despite the .json URL) → miss, fall through.
          return { kind: 'miss' }
        }
      }
      if (response.status !== 404) {
        throw new Error(`Could not load session (HTTP ${response.status}).`)
      }
      return { kind: 'miss' }
    }

    // --- Gen-3: {root}/<id>/content.json (self-contained folder) ---
    const gen3 = await tryLoadContentJson(contentUrl(id))
    if (gen3.kind === 'hit') return gen3.text

    // --- Gen-2: loose {root}/<id>.json (prior production typed-JSON-document) ---
    const gen2 = await tryLoadContentJson(looseJsonUrl(id))
    if (gen2.kind === 'hit') return gen2.text

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
    if (!id || id === activeSessionId.value) return { restored: false }

    // isSessionLoading drives the "Loading Project..." overlay in
    // WorkspacePane.vue. Set true for the duration of the switch (including
    // any autosave of the outgoing session) and reset in finally so a thrown
    // loadSession does not leave the overlay stuck. Boot-time restore also
    // routes through this method — showing the overlay during initial
    // restore is desirable UX, not a regression.
    isSessionLoading.value = true
    let restored = false
    try {
      // Auto-save outgoing session if there are unsaved changes.
      // Cycle 046: route through flushPendingSaves so the save runs through
      // the canonical queue (serialised against any in-flight autosave).
      if (isDirty.value && activeSessionId.value) {
        await flushPendingSaves(3000)
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

        // ──────────────────────────────────────────────────────────────────
        // Guard C boot-restore (Cycle 048, 2026-05-24) — MUST run here, NOT
        // from an external watcher.
        //
        // Bug history: prior implementation called restoreLocalStorageDraftIfNewer
        // from an App.vue `watch(activeSessionId, ...)` with nextTick scheduling.
        // The race:
        //   1. activeSessionId.value = id  → watcher queues nextTick(restore).
        //   2. await loadSession(id)       → microtasks drain → nextTick fires
        //      → restore reads document.value (still empty!) → restores backup.
        //   3. loadSession resolves        → `document.value = content` CLOBBERS
        //      the restore.
        //   4. setupSessionAutosave runs LATER (App.vue) → watcher missed the
        //      whole exchange, nothing schedules a save.
        // Net: offline edits silently lost across browser close.
        //
        // Fix: run restore HERE, after `document.value = content` has settled
        // the pod content and `_lastSavedContent` is the pod baseline. If the
        // localStorage backup differs from the pod, restore wins and we
        // synchronously enqueue a save so the pod catches up the moment the
        // network is back — no dependency on the autosave watcher being
        // installed at the right time, no dependency on the user typing again.
        if (restoreLocalStorageDraftIfNewer(id)) {
          restored = true
          // Surface as dirty so any explicit save callers see the right
          // state; setupSessionAutosave's watcher (when present) will also
          // observe the document mutation made by the restore and arm its
          // debounce — but we don't rely on it.
          isDirty.value = true
          // Enqueue the save NOW. Resource-key serialisation in the queue
          // means if a subsequent autosave enqueues, they run FIFO against
          // the same key, no race. If offline, the task fails per existing
          // semantics (backup retained, isDirty=true).
          if (_podRoot) {
            // Queue resourceKey is the Gen-3 contentUrl — the file actually written
            // by saveCurrentSession. MUST match the key used by enqueueWorkbookSave
            // and watched by flushPendingSaves, or a flush would never see this
            // save's terminal event (Cycle 066-extended path centralisation).
            const sessionFileUrl = contentUrl(id)
            const sessionName = sessionList.value.find(s => s.id === id)?.name
              ?? 'Session'
            // _writeLocalStorageBackup is already current (the restore just
            // wrote then read it; saveCurrentSession will re-write before
            // PUT and clear on success).
            ur.enqueueSave({
              resourceKey: sessionFileUrl,
              label: 'workbook-save-after-restore',
              task: () => saveCurrentSession(sessionName)
            })
          }
        }
        // ──────────────────────────────────────────────────────────────────
      } catch (err) {
        sessionSaveError.value = 'Could not load session content.'
      }
    } finally {
      isSessionLoading.value = false
    }
    return { restored }
  }

  // --- Rename helpers ---

  /**
   * Renames a session (updates name in index.json and, for an already-migrated
   * Gen-3 project, in the in-folder manifest.json).
   *
   * Spec: 3P.F.SessionRename
   * @param {string} id - Session ID to rename.
   * @param {string} newName - New session name. Empty strings are rejected.
   * @returns {Promise<void>}
   */
  async function renameSession(id, newName) {
    const trimmed = newName.trim()
    if (!trimmed) return

    // Capture the OLD name BEFORE the optimistic update destroys it — needed to
    // recognise and update the seeded `# <oldName>` heading (rename-safety,
    // criterion 3).
    const oldName = sessionList.value.find(s => s.id === id)?.name ?? ''

    // Optimistic update — update UI immediately.
    sessionList.value = sessionList.value.map(s =>
      s.id === id ? { ...s, name: trimmed, lastModified: new Date().toISOString() } : s
    )

    // Rename-safety (criterion 3): if THIS is the open project and its document
    // still carries the machine-seeded `# <oldName>` heading on the first line,
    // rewrite it to `# <trimmed>` in place. We mutate document.value only — the
    // EXISTING change-aware autosave persists it (no content PUT added here, so the
    // Cycle-046/047 rename-race that dropped the body re-PUT cannot recur). If the
    // user edited the heading, rewriteSeededHeading returns null and we leave the
    // body untouched — never appending a duplicate name line. Not-open projects are
    // not touched: their name is authoritative in index.json/manifest.json and the
    // stale heading (if any) is corrected on next open + edit.
    if (id === activeSessionId.value) {
      const rewritten = rewriteSeededHeading(document.value, oldName, trimmed)
      if (rewritten !== null && rewritten !== document.value) {
        document.value = rewritten
      }
    }

    // Persist updated index.
    await saveIndex()

    // Keep the in-folder manifest's name in sync for an already-migrated (Gen-3)
    // project, so the portable folder carries the new name even if the content is
    // never re-edited (criterion 1 — manifest is the source of truth for identity).
    // No-op for un-migrated Gen-2/Gen-1 (their next content-save migrates with the
    // correct name). The manifest holds NO content blocks, so this is safe from the
    // Cycle-046 rename-race that made the BODY re-PUT get dropped (Path 9): we never
    // re-PUT the content body on rename — only the small identity manifest.
    await syncManifestIfMigrated(id)
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

    // Spec: 4Sol.S.TwinPodSessionIndex — index.json is written on project label change.
    await saveIndex()
    // Keep the in-folder manifest's `project` (grouping label) in sync for an
    // already-migrated Gen-3 project — the rebuild reconstructs the catalog entry's
    // project from the manifest, so a stale manifest project would defeat criterion 2.
    await syncManifestIfMigrated(id)
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

    // Best-effort: delete the project's identity files from the pod across all
    // generations. 404 / 405 / network errors on any are acceptable — the index has
    // already been updated and is the authoritative project list. We delete the
    // Gen-3 in-folder content.json + manifest.json, the Gen-2 loose {id}.json, and
    // the Gen-1 {id}.md. We do NOT delete the {id}/ container itself nor the user's
    // uploaded attachments inside it — removing user attachments is out of scope for
    // a project delete, and a non-empty-container DELETE would 405 anyway.
    //
    // BareFileSave 2026-05-23: switched from raw ur.hyperFetch DELETE (which left
    // local rdfStore stale and silently swallowed all errors) to ur.deleteURI —
    // canonical primitive that DELETEs on the server AND prunes both directions
    // of rdfStore (`(*, *, uri)` and `(uri, *, *)`). Failures emit a console.warn
    // and surface on sessionDeleteError (non-blocking) per the brief.
    const gen3ContentUrl = contentUrl(id)   // Gen-3 in-folder content.
    const gen3ManifestUrl = manifestUrl(id) // Gen-3 in-folder manifest.
    const jsonUrl = looseJsonUrl(id)        // Gen-2 loose {id}.json.
    const mdUrl = sessionsRoot() + '/' + id + '.md' // Gen-1 {id}.md (historical).
    sessionDeleteError.value = null
    try {
      const okContent = await ur.deleteURI(gen3ContentUrl)
      if (!okContent) console.warn('[useSessionIndex] deleteURI returned false for', gen3ContentUrl)
    } catch (err) {
      console.warn('[useSessionIndex] deleteURI threw for', gen3ContentUrl, err?.message || err)
      sessionDeleteError.value = `Could not delete project content (${err?.message || 'unknown error'})`
    }
    // The remaining three are historical/derived artefacts — 404 is the expected
    // case for any a given project never had. Don't warn on a false (404) return.
    for (const url of [gen3ManifestUrl, jsonUrl, mdUrl]) {
      try {
        await ur.deleteURI(url)
      } catch (err) {
        console.warn('[useSessionIndex] deleteURI threw for', url, err?.message || err)
      }
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
    // Queue resourceKey is the Gen-3 contentUrl — the file saveCurrentSession
    // actually PUTs. Same key as the post-restore enqueue and the flush drain-watch.
    const sessionFileUrl = contentUrl(id)
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
    //    resourceKey MUST equal the contentUrl used by enqueueWorkbookSave —
    //    a mismatch here would make the drain-watch never observe completion.
    const sessionFileUrl = contentUrl(activeSessionId.value)
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

  /**
   * Records the DPoP-authenticated session fetch function.
   * Must be called by App.vue right after setPodRoot — before any container
   * pre-creation can run. Parallel to the useCreditLedger / loadCredits pattern
   * where session.fetch is passed as a parameter rather than accessed via
   * window.solid.session (which would violate the single-namespace rule).
   *
   * Spec: required by _ensureContainer to issue HEAD + PUT requests to the pod.
   *
   * @param {Function} sessionFetchFn - session.fetch.bind(session) from App.vue.
   */
  function setSessionFetch(sessionFetchFn) {
    _sessionFetch = typeof sessionFetchFn === 'function' ? sessionFetchFn : null
  }

  return {
    sessionList,
    activeSessionId,
    indexLoading,
    indexLoadError,
    indexLoaded,
    sessionSaving,
    sessionSaveError,
    sessionDeleteError,
    isSessionLoading,
    isSavingProject,
    isDirty,
    setPodRoot,
    setSessionFetch,
    loadIndex,
    saveIndex,
    rebuildIndexFromManifests,
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
