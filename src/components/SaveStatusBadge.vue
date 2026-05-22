<!-- UNIT_TYPE=Widget -->
<!--
  SaveStatusBadge — global indicator for background-save lifecycle.

  Mount once at the app root (typically inside App.vue's <template>) — it
  Teleports itself to <body> and reads from the module-level singleton
  state in useBackgroundSave, so any view that enqueues a save anywhere
  in the app surfaces here.

  Visual states (in priority order):
    1. ANY failed job → persistent red toast with Retry + Dismiss buttons.
       Failed jobs stay visible until the user acts. (Shown when showErrors)
    2. ANY running job → blue "Saving…" pill with spinner. Auto-dismisses
       when the queue drains. (Shown when showSaving)
    3. ANY just-succeeded job → green "Saved ✓" pill, auto-fades after
       SUCCESS_TTL_MS (2.5s) defined in useBackgroundSave. (Shown when showSuccess)
    4. Idle → nothing rendered.

  Props (all default true — opt out per app for the silent-save UX):
    showSaving  Show the blue "Saving…" pill while any save is running.
    showSuccess Show the green "Saved ✓" pill after a successful save.
    showErrors  Show persistent red error toasts on save failure.

  Common configurations:
    Full feedback (default):
        <SaveStatusBadge />
    Silent on success, visible on failure (recommended for inline-edit apps):
        <SaveStatusBadge :show-saving="false" :show-success="false" />
    Fully silent (errors only logged to console):
        omit the component entirely.

  Accessibility:
    aria-live="polite" on the wrapper so screen-readers announce changes
    without interrupting other content. The error block is role="alert"
    so failures are announced immediately.
-->
<script setup>
import { computed } from 'vue'
import { useBackgroundSave } from '../composables/useBackgroundSave.js'

const props = defineProps({
  showSaving:  { type: Boolean, default: true },
  showSuccess: { type: Boolean, default: true },
  showErrors:  { type: Boolean, default: true },
})

const { anySaving, succeeded, failed, retry, dismiss } = useBackgroundSave()

// Gated views of the queue state — each visual block reads the gated copy so
// the template logic stays declarative.
const showSavingPill  = computed(() => props.showSaving  && anySaving.value)
const showSuccessPill = computed(() => props.showSuccess && succeeded.value.length > 0)
const visibleFailed   = computed(() => props.showErrors  ? failed.value : [])
</script>

<template>
  <Teleport to="body">
    <div class="tpu-save-status" aria-live="polite">
      <!-- Failed toasts (persistent — one per failed job) -->
      <transition-group name="tpu-save-fade" tag="div" class="tpu-save-status__failed">
        <div v-for="job in visibleFailed" :key="job.id" class="tpu-save-status__error" role="alert">
          <span class="tpu-save-status__icon" aria-hidden="true">⚠</span>
          <span class="tpu-save-status__text">
            Save failed<template v-if="job.label !== 'save'">: {{ job.label }}</template>
          </span>
          <button type="button" class="tpu-save-status__btn" @click="retry(job.id)">Retry</button>
          <button type="button" class="tpu-save-status__btn tpu-save-status__btn--ghost" @click="dismiss(job.id)" aria-label="Dismiss">×</button>
        </div>
      </transition-group>

      <!-- Single Saving / Saved pill (mutually exclusive) -->
      <transition name="tpu-save-fade">
        <div v-if="showSavingPill" class="tpu-save-status__pill tpu-save-status__pill--running">
          <span class="tpu-save-status__spinner" aria-hidden="true"></span>
          <span>Saving…</span>
        </div>
        <div v-else-if="showSuccessPill" class="tpu-save-status__pill tpu-save-status__pill--success">
          <span aria-hidden="true">✓</span>
          <span>Saved</span>
        </div>
      </transition>
    </div>
  </Teleport>
</template>

<style scoped>
.tpu-save-status {
  position: fixed;
  bottom: 1rem;
  right: 1rem;
  z-index: 9999;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  align-items: flex-end;
  pointer-events: none;     /* don't block clicks on the rest of the app */
}

.tpu-save-status__failed { display: flex; flex-direction: column; gap: 0.5rem; }

.tpu-save-status__pill,
.tpu-save-status__error {
  pointer-events: auto;      /* but DO accept clicks on the visible chips */
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 0.875rem;
  border-radius: 9999px;
  font-size: 0.875rem;
  font-weight: 500;
  color: #fff;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.18);
}

.tpu-save-status__pill--running { background: #1e3a8a; }
.tpu-save-status__pill--success { background: #16a34a; }

.tpu-save-status__error {
  background: #b91c1c;
  border-radius: 0.5rem;     /* error is a toast, not a pill */
}

.tpu-save-status__btn {
  background: rgba(255, 255, 255, 0.16);
  border: 1px solid rgba(255, 255, 255, 0.45);
  color: inherit;
  font-size: 0.75rem;
  padding: 0.25rem 0.5rem;
  border-radius: 0.25rem;
  cursor: pointer;
  font-weight: 600;
}
.tpu-save-status__btn:hover  { background: rgba(255, 255, 255, 0.28); }
.tpu-save-status__btn:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
.tpu-save-status__btn--ghost {
  background: transparent;
  border-color: transparent;
  font-size: 1.1em;
  padding: 0 0.25em;
  line-height: 1;
}

.tpu-save-status__spinner {
  width: 0.85em;
  height: 0.85em;
  border: 2px solid rgba(255, 255, 255, 0.35);
  border-top-color: #fff;
  border-radius: 50%;
  animation: tpu-save-status-spin 0.8s linear infinite;
}
@keyframes tpu-save-status-spin { to { transform: rotate(360deg); } }

.tpu-save-fade-enter-active,
.tpu-save-fade-leave-active {
  transition: opacity 240ms ease, transform 240ms ease;
}
.tpu-save-fade-enter-from,
.tpu-save-fade-leave-to {
  opacity: 0;
  transform: translateY(8px);
}
</style>
