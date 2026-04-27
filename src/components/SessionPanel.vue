<!-- UNIT_TYPE=Widget -->
<!--
  SessionPanel.vue

  Displays the session list and handles all session management UI:
  - Sorted list of sessions (lastModified descending)
  - Inline rename for session name (double-click or pencil icon → input → Enter/blur confirms)
  - Inline rename for project label (same pattern — ≤ 2 user actions to meet V.SessionProjectChangeability Goal)
  - "New Session" button
  - Active session highlighted with is-active CSS class
  - Empty state placeholder
  - Clickable list items that call switchToSession (Evo3)
  - Save button and save/error status indicators (Evo3)

  All values injected from App.vue provide context.
  All CSS uses var(--color-*), var(--space-*) tokens — zero hardcoded hex values.

  Spec: 3P.F.SessionList, 3P.F.SessionCreate, 3P.F.SessionRename,
        3P.F.SessionSave, 3P.F.SessionSwitch,
        3P.V.SessionListLatency, 3P.V.SessionProjectChangeability,
        3P.V.SessionSwitchLatency
-->

<script>
/**
 * Session management panel.
 *
 * Renders the session list sidebar. Provides:
 *   - Sorted session list (newest first)
 *   - Inline name rename (double-click → input → Enter/blur)
 *   - Inline project label rename (same pattern — ≤ 2 actions for V.SessionProjectChangeability)
 *   - "New Session" button
 *   - Active session header
 *   - Empty state message
 *   - Per-session click-to-switch (Evo3)
 *   - Save button with saving indicator and inline error (Evo3)
 *
 * Injected from App.vue provide:
 *   sessionList, activeSessionId, createNewSession, renameSession,
 *   renameSessionProject, switchToSession, saveCurrentSession,
 *   sessionSaving, sessionSaveError
 *
 * @see Spec: 5 - Project/The Brain/01Planning/TheBrain-Specs/3P.F.SessionList.md
 * @see Spec: 5 - Project/The Brain/01Planning/TheBrain-Specs/3P.F.SessionRename.md
 * @see Spec: 5 - Project/The Brain/01Planning/TheBrain-Specs/3P.V.SessionProjectChangeability.md
 */

import { computed, ref, inject, nextTick } from 'vue'

export default {
  name: 'SessionPanel',

  emits: ['close'],

  setup(props, { emit }) {
    // --- Inject shared session state from App.vue ---

    /** @type {import('vue').Ref<Array<{id:string,name:string,project:string,lastModified:string}>>} */
    const sessionList     = inject('sessionList')

    /** @type {import('vue').Ref<string|null>} */
    const activeSessionId = inject('activeSessionId')

    /** @type {() => Promise<void>} */
    const createNewSession    = inject('createNewSession')

    /** @type {(id: string, newName: string) => Promise<void>} */
    const renameSession       = inject('renameSession')

    /** @type {(id: string, newProject: string) => Promise<void>} */
    const renameSessionProject = inject('renameSessionProject')

    /** @type {(id: string) => Promise<void>} */
    const switchToSession     = inject('switchToSession')

    /** @type {(name: string) => Promise<void>} */
    const saveCurrentSession  = inject('saveCurrentSession')

    /** @type {(id: string) => Promise<void>} */
    const deleteSession       = inject('deleteSession')

    /** @type {import('vue').Ref<boolean>} */
    const sessionSaving       = inject('sessionSaving')

    /** @type {import('vue').Ref<string|null>} */
    const sessionSaveError    = inject('sessionSaveError')

    // Logout — injected from App.vue provide('auth', { ..., logout })
    const auth = inject('auth')
    const logout = () => auth?.logout?.()

    // --- Sorted session list ---
    //
    // Use a computed spread to avoid mutating the reactive ref.
    // Sort by lastModified descending (most recent first) per F.SessionList Success-Criteria.
    // Spec: 3P.F.SessionList — "ordered by last-modified descending"
    const sortedSessions = computed(() =>
      [...sessionList.value].sort((a, b) => {
        // ISO strings sort lexicographically in the same order as date order.
        if (a.lastModified < b.lastModified) return 1
        if (a.lastModified > b.lastModified) return -1
        return 0
      })
    )

    // --- Active session name for panel header ---
    //
    // Spec: 3P.F.SessionCreate — "new session name appears in session panel header"
    const activeSession = computed(() =>
      sessionList.value.find(s => s.id === activeSessionId.value) ?? null
    )

    // --- Inline rename state for session names ---
    //
    // renamingNameId: session id currently being renamed (null = none)
    // renameNameValue: current text in the name input
    // renameNameError: empty-name rejection message
    // isNamingNewSession: true when rename was auto-activated for a newly created session.
    //   When true, confirming OR cancelling the rename also emits 'close' so the user
    //   lands in the workspace immediately after naming their new project.
    const renamingNameId      = ref(null)
    const renameNameValue     = ref('')
    const renameNameError     = ref('')
    const isNamingNewSession  = ref(false)

    // --- Inline rename state for project labels ---
    //
    // renamingProjectId: session id whose project label is being renamed
    const renamingProjectId   = ref(null)
    const renameProjectValue  = ref('')
    const renameProjectError  = ref('')

    // --- Inline delete confirmation state ---
    //
    // deletingId: the session id currently "armed" for deletion.
    // Clicking the trash icon arms the session (shows inline "Delete?" confirmation).
    // Clicking Delete confirms; clicking Cancel or clicking another session dismisses.
    const deletingId = ref(null)

    // --- Switch in-progress guard ---
    //
    // switchingId: the session id being switched to, while the switch is in flight.
    // Disabled/loading state is applied to list items while switch is in progress
    // to prevent double-click. Spec: 3P.F.SessionSwitch disabled-state requirement.
    const switchingId = ref(null)

    // --- Inline name rename handlers ---

    /**
     * Activates inline rename for a session name.
     * Spec: 3P.F.SessionRename — "transitions to editable field within 200ms of double-click"
     * @param {object} session - The session entry to rename.
     */
    function activateNameRename(session) {
      renamingNameId.value  = session.id
      renameNameValue.value = session.name
      renameNameError.value = ''
      // Focus, select-all, and scroll into view on next tick after the DOM
      // renders the input element.
      // select() ensures the default name is fully selected so the user can
      // immediately type their chosen name without manually clearing it first.
      nextTick(() => {
        const input = document.getElementById(`name-input-${session.id}`)
        if (input) {
          input.scrollIntoView({ block: 'nearest' })
          input.focus()
          input.select()
        }
      })
    }

    /**
     * Confirms the inline name rename: calls renameSession and exits rename mode.
     * Empty names are rejected with an inline message.
     * If this was triggered for a newly created session (isNamingNewSession), emits
     * 'close' after the rename so the user lands directly in the workspace.
     * Spec: 3P.F.SessionRename — "commit (Enter or blur) writes new name to index"
     * @param {string} sessionId - Session ID being renamed.
     */
    async function confirmNameRename(sessionId) {
      let trimmed = renameNameValue.value.trim()
      if (!trimmed) {
        if (isNamingNewSession.value) {
          // New session with no name typed: fall back to the auto-generated default
          // (e.g. "New Session — 2026-04-26") rather than showing an error.
          // The default name was set by createNewSession() and is already in sessionList.
          trimmed = sessionList.value.find(s => s.id === sessionId)?.name ?? ''
        }
        if (!trimmed) {
          // Regular rename with empty input: reject with an inline error.
          // Spec: 3P.F.SessionRename — empty name is rejected
          renameNameError.value = 'Session name cannot be empty.'
          return
        }
      }
      renamingNameId.value = null
      renameNameError.value = ''
      const wasNewSession = isNamingNewSession.value
      isNamingNewSession.value = false
      await renameSession(sessionId, trimmed)
      if (wasNewSession) emit('close')
    }

    /**
     * Cancels inline name rename without writing to the pod.
     * If this was triggered for a newly created session (isNamingNewSession), emits
     * 'close' so the user reaches the workspace (the session keeps its default name).
     * Spec: 3P.F.SessionRename — "Escape dismissal leaves pod data unchanged"
     */
    function cancelNameRename() {
      renamingNameId.value  = null
      renameNameValue.value = ''
      renameNameError.value = ''
      if (isNamingNewSession.value) {
        isNamingNewSession.value = false
        emit('close')
      }
    }

    /**
     * Handles keydown inside the name rename input.
     * Enter → confirm, Escape → cancel.
     * @param {KeyboardEvent} event
     * @param {string} sessionId
     */
    async function onNameInputKeydown(event, sessionId) {
      if (event.key === 'Enter') {
        event.preventDefault()
        await confirmNameRename(sessionId)
      } else if (event.key === 'Escape') {
        cancelNameRename()
      }
    }

    // --- Inline project label rename handlers ---

    /**
     * Activates inline rename for a session's project label.
     * Spec: 3P.V.SessionProjectChangeability — ≤ 2 user actions to change project label.
     * Action 1: double-click on project label.
     * @param {object} session - The session entry.
     */
    function activateProjectRename(session) {
      renamingProjectId.value  = session.id
      renameProjectValue.value = session.project ?? 'The Brain'
      renameProjectError.value = ''
      nextTick(() => {
        const input = document.getElementById(`project-input-${session.id}`)
        if (input) input.focus()
      })
    }

    /**
     * Confirms the inline project rename: calls renameSessionProject.
     * Empty project names are rejected.
     * Spec: 3P.V.SessionProjectChangeability — action 2 is Enter (confirm).
     * @param {string} sessionId
     */
    async function confirmProjectRename(sessionId) {
      const trimmed = renameProjectValue.value.trim()
      if (!trimmed) {
        renameProjectError.value = 'Project name cannot be empty.'
        return
      }
      renamingProjectId.value = null
      renameProjectError.value = ''
      await renameSessionProject(sessionId, trimmed)
    }

    /**
     * Cancels inline project rename without writing.
     * Spec: 3P.V.SessionProjectChangeability — Escape restores original value.
     */
    function cancelProjectRename() {
      renamingProjectId.value  = null
      renameProjectValue.value = ''
      renameProjectError.value = ''
    }

    /**
     * Handles keydown inside the project rename input.
     * Enter → confirm, Escape → cancel.
     * @param {KeyboardEvent} event
     * @param {string} sessionId
     */
    async function onProjectInputKeydown(event, sessionId) {
      if (event.key === 'Enter') {
        event.preventDefault()
        await confirmProjectRename(sessionId)
      } else if (event.key === 'Escape') {
        cancelProjectRename()
      }
    }

    // --- Session switch handler ---

    /**
     * Switches to the selected session.
     * Sets switchingId during the in-flight switch to disable the list item.
     * Spec: 3P.F.SessionSwitch — click handler on each list item.
     * @param {string} id - Session ID to switch to.
     */
    async function onSessionClick(id) {
      // Guard: already switching, or clicking the active session.
      if (switchingId.value || id === activeSessionId.value) return
      switchingId.value = id
      try {
        await switchToSession(id)
        // Close the panel after a successful switch so the workspace is immediately visible.
        emit('close')
      } finally {
        switchingId.value = null
      }
    }

    // --- Delete handlers ---

    /**
     * Arms the delete confirmation for a session.
     * The trash icon turns red and an inline confirmation strip appears.
     * Clicking the trash on a different session dismisses the previous one.
     * @param {string} id - Session ID to arm.
     */
    function armDelete(id) {
      deletingId.value = deletingId.value === id ? null : id
    }

    /**
     * Confirms deletion of the armed session.
     * Calls deleteSession(), which removes the session and updates the workspace.
     * @param {string} id - Session ID to delete.
     */
    async function confirmDelete(id) {
      deletingId.value = null
      await deleteSession(id)
    }

    /**
     * Dismisses the delete confirmation without taking action.
     */
    function cancelDelete() {
      deletingId.value = null
    }

    // --- New session handler ---

    /**
     * Creates a new session, then immediately activates inline rename for its name
     * so the user can type the project name before the panel closes.
     *
     * The panel stays open during naming. On confirm (Enter/blur) or cancel (Escape),
     * confirmNameRename / cancelNameRename detect isNamingNewSession and emit 'close'.
     *
     * Spec: 3P.F.SessionCreate — new session starts with empty workspace and name
     *       ready to edit.
     */
    async function onCreateNewSession() {
      await createNewSession()
      // Find the newly created session — it is the current activeSessionId.
      const newSession = sessionList.value.find(s => s.id === activeSessionId.value)
      if (newSession) {
        isNamingNewSession.value = true
        activateNameRename(newSession)
        // Clear the pre-filled default name so the placeholder is visible.
        // An empty field with placeholder text ("Session name…") is obviously
        // editable — the selected-text highlight is invisible against the panel
        // background. If the user confirms without typing, confirmNameRename
        // falls back to the auto-generated name rather than rejecting.
        renameNameValue.value = ''
      } else {
        // Fallback: no session found (unlikely) — just close.
        emit('close')
      }
    }

    // --- Explicit save handler ---

    /**
     * Triggers an explicit save of the current session.
     * Uses the active session's name from sessionList.
     * Spec: 3P.F.SessionSave — explicit save button.
     */
    async function onSave() {
      if (!activeSession.value || sessionSaving.value) return
      await saveCurrentSession(activeSession.value.name)
    }

    return {
      sortedSessions,
      activeSession,
      activeSessionId,
      onCreateNewSession,
      sessionSaving,
      sessionSaveError,
      // Name rename
      renamingNameId,
      renameNameValue,
      renameNameError,
      activateNameRename,
      confirmNameRename,
      cancelNameRename,
      onNameInputKeydown,
      // Project rename
      renamingProjectId,
      renameProjectValue,
      renameProjectError,
      activateProjectRename,
      confirmProjectRename,
      cancelProjectRename,
      onProjectInputKeydown,
      // Switch
      switchingId,
      onSessionClick,
      // Delete
      deletingId,
      armDelete,
      confirmDelete,
      cancelDelete,
      // Save
      onSave,
      // Auth
      logout
    }
  }
}
</script>

<template>
  <!--
    Session panel root.
    role="complementary" — this is a supporting navigation panel beside the main workspace.
    Spec: Rule_Code_accessibility — semantic HTML, WCAG 2.1 AA.
  -->
  <aside class="session-panel" role="complementary" aria-label="Session panel">

    <!-- ============================================================ -->
    <!-- Panel header — shows active session name + save button       -->
    <!-- Spec: 3P.F.SessionCreate — active session name in header     -->
    <!-- ============================================================ -->
    <header class="session-panel__header">
      <h2 class="session-panel__title">
        {{ activeSession ? activeSession.name : 'No active session' }}
      </h2>

      <!--
        Explicit save button.
        Spec: 3P.F.SessionSave — visible save trigger in panel header.
        V.MobileUX — min-height: 44px touch target.
      -->
      <button
        v-if="activeSession"
        class="session-panel__save-btn"
        :disabled="sessionSaving"
        :aria-busy="sessionSaving || undefined"
        aria-label="Save current session"
        @click="onSave"
      >
        <span v-if="sessionSaving" class="session-panel__saving-dot" aria-hidden="true" />
        <span v-if="sessionSaving" class="session-panel__saving-dot" aria-hidden="true" />
        <span v-if="sessionSaving" class="session-panel__saving-dot" aria-hidden="true" />
        <span v-else>Save</span>
      </button>
    </header>

    <!--
      Save error message — non-modal inline display.
      Spec: 3P.F.SessionSave — "show sessionSaveError as non-modal inline message"
      aria-live="polite" announces the error to screen readers without interrupting.
    -->
    <div
      v-if="sessionSaveError"
      class="session-panel__save-error"
      role="alert"
      aria-live="polite"
    >
      {{ sessionSaveError }}
    </div>

    <!-- ============================================================ -->
    <!-- New Session button                                           -->
    <!-- Spec: 3P.F.SessionCreate — "New Session" button             -->
    <!-- V.MobileUX — min-height: 44px                               -->
    <!-- ============================================================ -->
    <button
      class="session-panel__new-btn"
      @click="onCreateNewSession"
    >
      + New Session
    </button>

    <!-- ============================================================ -->
    <!-- Session list                                                  -->
    <!-- Spec: 3P.F.SessionList — sorted list, all sessions visible  -->
    <!-- ============================================================ -->

    <!--
      Empty state — shown when sessionList is empty (fresh install or no sessions).
      Spec: 3P.F.SessionList — "empty state shows placeholder text"
      aria-live="polite" announces the state to screen readers when it changes.
    -->
    <p
      v-if="sortedSessions.length === 0"
      class="session-panel__empty"
      aria-live="polite"
    >
      No saved sessions
    </p>

    <ul
      v-else
      class="session-panel__list"
      role="list"
    >
      <li
        v-for="session in sortedSessions"
        :key="session.id"
        :data-session-id="session.id"
        class="session-panel__item"
        :class="{
          'is-active': session.id === activeSessionId,
          'is-switching': session.id === switchingId
        }"
        :aria-current="session.id === activeSessionId ? 'true' : undefined"
      >
        <!--
          Session name row.
          The name is either displayed as text (with a rename trigger button)
          or as an inline edit input.
          Spec: 3P.F.SessionRename — double-click or pencil icon activates rename.
          Spec: Rule_Code_accessibility — keyboard accessible rename trigger.
        -->
        <div class="session-panel__name-row">
          <!-- Name display mode -->
          <template v-if="renamingNameId !== session.id">
            <!--
              Clickable name acts as the session switch trigger.
              Spec: 3P.F.SessionSwitch — clicking a session switches to it.
              Disabled while a switch is in progress.
            -->
            <button
              class="session-panel__session-btn"
              :disabled="!!switchingId || undefined"
              :aria-label="`Switch to session: ${session.name}`"
              @click="onSessionClick(session.id)"
            >
              <span class="session-panel__name-text">{{ session.name }}</span>
            </button>

            <!--
              Pencil icon rename trigger.
              Also triggered by double-click (handled on the button via @dblclick).
              Spec: 3P.F.SessionRename — pencil icon or double-click activates rename.
              aria-label tells screen readers what this button does.
            -->
            <button
              class="session-panel__rename-btn"
              :aria-label="`Rename session: ${session.name}`"
              @click.stop="activateNameRename(session)"
              @dblclick.stop="activateNameRename(session)"
            >
              <!-- Pencil icon SVG — decorative, aria-hidden -->
              <svg width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden="true" focusable="false">
                <path d="M9.5 1.5l2 2L4 11H2v-2L9.5 1.5z" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"/>
              </svg>
            </button>

            <!--
              Trash icon delete trigger.
              First click arms the confirmation strip; second (Delete button) confirms.
              Spec: 3P.F.SessionDelete — trash icon activates delete confirmation.
              Min 44×44px touch target per V.MobileUX.
            -->
            <button
              class="session-panel__delete-btn"
              :class="{ 'is-armed': deletingId === session.id }"
              :aria-label="`Delete session: ${session.name}`"
              :aria-expanded="deletingId === session.id || undefined"
              @click.stop="armDelete(session.id)"
            >
              <!-- Trash icon SVG — decorative, aria-hidden -->
              <svg width="13" height="14" viewBox="0 0 13 14" fill="none" aria-hidden="true" focusable="false">
                <path d="M1 3.5h11M4.5 3.5V2.5a.5.5 0 0 1 .5-.5h2a.5.5 0 0 1 .5.5v1M2.5 3.5l.75 8a.5.5 0 0 0 .5.5h5.5a.5.5 0 0 0 .5-.5l.75-8" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            </button>
          </template>

          <!-- Name edit mode -->
          <template v-else>
            <label :for="`name-input-${session.id}`" class="sr-only">Session name</label>
            <input
              :id="`name-input-${session.id}`"
              v-model="renameNameValue"
              class="session-panel__rename-input"
              type="text"
              placeholder="Session name…"
              :aria-describedby="renameNameError ? `name-error-${session.id}` : undefined"
              @keydown="onNameInputKeydown($event, session.id)"
              @blur="confirmNameRename(session.id)"
            />
            <span
              v-if="renameNameError"
              :id="`name-error-${session.id}`"
              class="session-panel__input-error"
              role="alert"
            >
              {{ renameNameError }}
            </span>
          </template>
        </div>

        <!--
          Delete confirmation strip — shown when the trash icon is clicked.
          Spec: 3P.F.SessionDelete — two-step delete (arm → confirm) prevents accidental deletion.
          role="alert" announces the confirmation to screen readers.
        -->
        <div
          v-if="deletingId === session.id"
          class="session-panel__delete-confirm"
          role="alert"
        >
          <span class="session-panel__delete-confirm-text">Delete this session?</span>
          <button
            class="session-panel__delete-confirm-yes"
            :aria-label="`Confirm delete session: ${session.name}`"
            @click.stop="confirmDelete(session.id)"
          >
            Delete
          </button>
          <button
            class="session-panel__delete-confirm-no"
            aria-label="Cancel delete"
            @click.stop="cancelDelete()"
          >
            Cancel
          </button>
        </div>

        <!--
          Last-modified timestamp — ISO string, no parsing per spec.
          Spec: 3P.F.SessionList — "each list item shows session name and last-modified date in ISO format"
        -->
        <time
          class="session-panel__modified"
          :datetime="session.lastModified"
        >
          {{ session.lastModified }}
        </time>

        <!--
          Switching indicator — shown on the list item being switched to.
          Spec: 3P.F.SessionSwitch — disabled/loading state while switch in progress.
        -->
        <span
          v-if="session.id === switchingId"
          class="session-panel__switching-label"
          aria-live="polite"
        >
          Loading…
        </span>

      </li>
    </ul>

    <!-- ============================================================ -->
    <!-- Panel footer — logout                                         -->
    <!-- ============================================================ -->
    <footer class="session-panel__footer">
      <button class="session-panel__logout-btn" @click="logout" aria-label="Log out">
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
          <polyline points="16 17 21 12 16 7"/>
          <line x1="21" y1="12" x2="9" y2="12"/>
        </svg>
        Log out
      </button>
    </footer>

  </aside>
</template>

<style scoped>
/*
 * SessionPanel styles
 * All values use design tokens from design-tokens.css.
 * Zero hardcoded hex values.
 * Mobile-first: base styles target 375px; desktop overrides in @media (min-width: 768px).
 * Spec: Rule_Code_mobile-first, 3P.V.MobileUX
 */

/* ============================================================
   Screen-reader-only utility
   Hides label text visually while keeping it accessible.
   ============================================================ */
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

/* ============================================================
   Panel root
   ============================================================ */
.session-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--color-surface-card);
  border-right: 1px solid var(--color-border-subtle);
  overflow: hidden;
}

/* ============================================================
   Header
   ============================================================ */
.session-panel__header {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.75rem 0.875rem;
  border-bottom: 1px solid var(--color-border-subtle);
  flex-shrink: 0;
}

.session-panel__title {
  flex: 1;
  min-width: 0;
  font-size: 0.875rem;
  font-weight: 600;
  color: var(--color-text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  line-height: 1.4;
}

/* ============================================================
   Save button
   Spec: V.MobileUX — min-height 44px touch target
   ============================================================ */
.session-panel__save-btn {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.2rem;
  min-height: 44px;
  padding: 0 0.75rem;
  background: var(--color-primary);
  color: var(--color-surface-white);
  border: none;
  border-radius: 0.375rem;
  font-size: 0.8125rem;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.15s, opacity 0.15s;
}

.session-panel__save-btn:hover:not(:disabled) {
  background: var(--color-primary-dark);
}

.session-panel__save-btn:disabled {
  opacity: 0.7;
  cursor: not-allowed;
}

.session-panel__save-btn:focus-visible {
  outline: 2px solid var(--color-border-active);
  outline-offset: 2px;
}

/* Saving dots — reuse the app's loading-dot animation style */
.session-panel__saving-dot {
  display: inline-block;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--color-surface-white);
  animation: session-saving-bounce 1.2s ease-in-out infinite;
}
.session-panel__saving-dot:nth-child(2) { animation-delay: 0.15s; }
.session-panel__saving-dot:nth-child(3) { animation-delay: 0.3s; }

@keyframes session-saving-bounce {
  0%, 80%, 100% { transform: scale(0.6); opacity: 0.5; }
  40%           { transform: scale(1);   opacity: 1; }
}

/* ============================================================
   Save error — non-modal inline message
   Spec: 3P.F.SessionSave — inline, non-blocking error display
   ============================================================ */
.session-panel__save-error {
  flex-shrink: 0;
  padding: 0.375rem 0.875rem;
  background: var(--color-error-light);
  color: var(--color-error-dark);
  font-size: 0.75rem;
  border-bottom: 1px solid var(--color-border-subtle);
}

/* ============================================================
   New Session button
   Spec: V.MobileUX — min-height 44px
   ============================================================ */
.session-panel__new-btn {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 44px;
  width: 100%;
  padding: 0 1rem;
  background: var(--color-primary-lighter);
  color: var(--color-primary-dark);
  border: none;
  border-bottom: 1px solid var(--color-border-subtle);
  font-size: 0.8125rem;
  font-weight: 600;
  cursor: pointer;
  text-align: left;
  transition: background 0.15s;
}

.session-panel__new-btn:hover {
  background: var(--color-primary-light);
}

.session-panel__new-btn:focus-visible {
  outline: 2px solid var(--color-border-active);
  outline-offset: -2px;
}

/* ============================================================
   Empty state
   ============================================================ */
.session-panel__empty {
  padding: 1.25rem 0.875rem;
  font-size: 0.8125rem;
  color: var(--color-text-muted);
  text-align: center;
}

/* ============================================================
   Session list
   ============================================================ */
.session-panel__list {
  flex: 1;
  overflow-y: auto;
  list-style: none;
  margin: 0;
  padding: 0;
}

/* ============================================================
   Session item
   ============================================================ */
.session-panel__item {
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
  padding: 0.625rem 0.875rem;
  border-bottom: 1px solid var(--color-border-minimal);
  background: var(--color-surface-card);
  transition: background 0.1s;
  /* Disable pointer events while a switch is in flight (prevent double-click) */
}

.session-panel__item:hover {
  background: var(--color-surface-base);
}

/* Active session highlight */
.session-panel__item.is-active {
  background: var(--color-primary-lightest);
  border-left: 3px solid var(--color-primary);
  padding-left: calc(0.875rem - 3px);
}

/* Switching (in-flight) — dimmed, non-interactive */
.session-panel__item.is-switching {
  opacity: 0.6;
  pointer-events: none;
}

/* ============================================================
   Name row — name text + rename trigger
   ============================================================ */
.session-panel__name-row {
  display: flex;
  align-items: center;
  gap: 0.25rem;
}

/*
 * Session switch button wraps the name text.
 * Full-row click target for switching.
 * Spec: 3P.F.SessionSwitch, V.MobileUX — min-height 44px on interactive elements.
 */
.session-panel__session-btn {
  flex: 1;
  min-width: 0;
  min-height: 44px;
  display: flex;
  align-items: center;
  background: none;
  border: none;
  padding: 0;
  cursor: pointer;
  text-align: left;
}

.session-panel__session-btn:disabled {
  cursor: not-allowed;
  opacity: 0.6;
}

.session-panel__session-btn:focus-visible {
  outline: 2px solid var(--color-border-active);
  outline-offset: 1px;
  border-radius: 2px;
}

.session-panel__name-text {
  font-size: 0.875rem;
  font-weight: 500;
  color: var(--color-text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ============================================================
   Project row — project label + rename trigger
   ============================================================ */
.session-panel__project-row {
  display: flex;
  align-items: center;
  gap: 0.25rem;
}

/*
 * Project label button — full-row click target.
 * Double-click activates inline rename (action 1 of 2 for V.SessionProjectChangeability).
 * min-height: 44px ensures mobile touch target compliance.
 */
.session-panel__project-btn {
  flex: 1;
  min-width: 0;
  min-height: 44px;
  display: flex;
  align-items: center;
  background: none;
  border: none;
  padding: 0;
  cursor: default;
  text-align: left;
}

.session-panel__project-btn:focus-visible {
  outline: 2px solid var(--color-border-active);
  outline-offset: 1px;
  border-radius: 2px;
}

.session-panel__project-text {
  font-size: 0.75rem;
  color: var(--color-text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ============================================================
   Rename trigger buttons (pencil icon)
   Spec: V.MobileUX — 44px touch target via padding
   ============================================================ */
.session-panel__rename-btn {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  /* 44px touch target via padding — icon is 13px, padding makes up the rest */
  min-width: 44px;
  min-height: 44px;
  background: none;
  border: none;
  padding: 0.75rem;
  color: var(--color-icon-muted);
  cursor: pointer;
  border-radius: 0.25rem;
  opacity: 0;
  transition: opacity 0.1s, color 0.1s;
}

/* Show pencil icon on hover of the parent item */
.session-panel__item:hover .session-panel__rename-btn,
.session-panel__item.is-active .session-panel__rename-btn {
  opacity: 1;
}

.session-panel__rename-btn:hover {
  color: var(--color-text-primary);
}

.session-panel__rename-btn:focus-visible {
  outline: 2px solid var(--color-border-active);
  outline-offset: 1px;
  opacity: 1;
}

/* Project rename pencil — slightly smaller than name rename pencil */
.session-panel__rename-btn--project {
  padding: 0.8rem;
}

/* ============================================================
   Trash / delete button — same base shape as rename-btn
   ============================================================ */
.session-panel__delete-btn {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 44px;
  min-height: 44px;
  background: none;
  border: none;
  padding: 0.75rem;
  color: var(--color-icon-muted);
  cursor: pointer;
  border-radius: 0.25rem;
  opacity: 0;
  transition: opacity 0.1s, color 0.1s;
}

/* Show on hover of the parent item (same rule as rename-btn) */
.session-panel__item:hover .session-panel__delete-btn,
.session-panel__item.is-active .session-panel__delete-btn {
  opacity: 1;
}

/* Armed state — turns red to signal destructive action is pending */
.session-panel__delete-btn:hover,
.session-panel__delete-btn.is-armed {
  color: var(--color-error-dark);
}

.session-panel__delete-btn:focus-visible {
  outline: 2px solid var(--color-border-active);
  outline-offset: 1px;
  opacity: 1;
}

/* ============================================================
   Inline delete confirmation strip
   Spec: 3P.F.SessionDelete — two-step delete; no modal
   ============================================================ */
.session-panel__delete-confirm {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.3rem 0 0.1rem;
  flex-wrap: wrap;
}

.session-panel__delete-confirm-text {
  flex: 1;
  font-size: 0.75rem;
  color: var(--color-error-dark);
  white-space: nowrap;
}

.session-panel__delete-confirm-yes,
.session-panel__delete-confirm-no {
  min-height: 28px;
  padding: 0 0.625rem;
  border-radius: 0.25rem;
  border: 1px solid;
  font-size: 0.75rem;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
}

.session-panel__delete-confirm-yes {
  background: var(--color-error-dark);
  color: var(--color-surface-white);
  border-color: var(--color-error-dark);
}

.session-panel__delete-confirm-yes:hover {
  filter: brightness(0.9);
}

.session-panel__delete-confirm-yes:focus-visible {
  outline: 2px solid var(--color-border-active);
  outline-offset: 2px;
}

.session-panel__delete-confirm-no {
  background: var(--color-surface-base);
  color: var(--color-text-secondary);
  border-color: var(--color-border-default);
}

.session-panel__delete-confirm-no:hover {
  background: var(--color-surface-card);
}

.session-panel__delete-confirm-no:focus-visible {
  outline: 2px solid var(--color-border-active);
  outline-offset: 2px;
}

/* ============================================================
   Inline rename input
   Spec: V.MobileUX — min-height 44px
   ============================================================ */
.session-panel__rename-input {
  flex: 1;
  min-width: 0;
  min-height: 44px;
  padding: 0.25rem 0.5rem;
  background: var(--color-surface-input);
  border: 1.5px solid var(--color-border-active);
  border-radius: 0.25rem;
  font-size: 0.875rem;
  color: var(--color-text-primary);
  outline: none;
}

.session-panel__rename-input--project {
  font-size: 0.75rem;
}

.session-panel__rename-input:focus {
  border-color: var(--color-primary);
  box-shadow: 0 0 0 2px var(--color-primary-lighter);
}

/* ============================================================
   Input error message
   Spec: Rule_Code_accessibility — error associated with field via aria-describedby
   ============================================================ */
.session-panel__input-error {
  font-size: 0.6875rem;
  color: var(--color-error-dark);
  margin-top: 0.125rem;
}

/* ============================================================
   Last-modified timestamp
   Spec: 3P.F.SessionList — "last-modified date in ISO format; no truncation of year/month/day"
   ============================================================ */
.session-panel__modified {
  font-size: 0.6875rem;
  color: var(--color-text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* ============================================================
   Switching indicator
   ============================================================ */
.session-panel__switching-label {
  font-size: 0.6875rem;
  color: var(--color-text-secondary);
  font-style: italic;
}

/* ============================================================
   Desktop overrides — ≥768px
   ============================================================ */
@media (min-width: 768px) {
  .session-panel__header {
    padding: 0.875rem 1rem;
  }

  .session-panel__new-btn {
    padding: 0 1rem;
  }

  .session-panel__item {
    padding: 0.625rem 1rem;
  }

  .session-panel__item.is-active {
    padding-left: calc(1rem - 3px);
  }
}

/* ============================================================
   Panel footer — logout button
   ============================================================ */
.session-panel__footer {
  margin-top: auto;
  padding: var(--space-md) var(--space-sm);
  border-top: 1px solid var(--color-border-subtle);
  display: flex;
  justify-content: center;
  align-items: center;
}

.session-panel__logout-btn {
  display: flex;
  align-items: center;
  gap: var(--space-xs);
  width: auto;
  padding: var(--space-sm) var(--space-md);
  min-height: 44px;
  background: none;
  border: none;
  border-radius: var(--radius-sm);
  color: var(--color-text-secondary);
  font-size: 0.875rem;
  cursor: pointer;
  text-align: center;
}

.session-panel__logout-btn:hover {
  background: var(--color-surface-hover);
  color: var(--color-text-primary);
}

.session-panel__logout-btn:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 2px;
}
</style>
