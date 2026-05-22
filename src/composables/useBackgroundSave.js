// UNIT_TYPE=Hook
//
// useBackgroundSave — Vue composable that wraps the framework-agnostic
// `ur.enqueueSave` queue (lives in @kaigilb/twinpod-client/src/save-queue.js)
// with reactive Vue state.
//
// Usage in a view that performs writes:
//
//   import { useBackgroundSave } from '@kaigilb/twinpod-ui'
//   const bg = useBackgroundSave()
//
//   function save() {
//     // 1. Update optimistic UI state (Pinia / refs) synchronously
//     store.setLocalProfile(form.value)
//     // 2. Navigate / close form / whatever the "instant" UX needs
//     router.push({ name: 'profile' })
//     // 3. Kick off the real save in the background — fire-and-forget
//     bg.submit({
//       resourceKey: `${podRoot}/i`,
//       label: 'profile-save',
//       task: async () => {
//         if (file) await photo.upload(podRoot, file, form.value.photoUri)
//         await writer.save(webId, form.value)
//       },
//     })
//   }
//
// Usage in a global status indicator (render once at app root):
//
//   import { SaveStatusBadge } from '@kaigilb/twinpod-ui'
//   // <SaveStatusBadge /> reads from this composable's singleton state.
//
// Singleton state — module-level:
//   The reactive jobs list lives at module scope so every consumer of
//   useBackgroundSave() observes the SAME state. Rendering the global
//   <SaveStatusBadge> once at the app root is sufficient; submitting from
//   any view reflects there.

import { ref, computed } from 'vue'
import { ur } from '@kaigilb/twinpod-client'

// How long a 'succeeded' job stays visible before garbage-collection.
// Tuned so a quick "Saved ✓" pill is readable but doesn't linger.
const SUCCESS_TTL_MS = 2500

// Module-level reactive state (singleton across all calls to useBackgroundSave).
// shape per job: { id, resourceKey, label, status, error, startedAt, endedAt, _retry }
//   status ∈ 'queued' | 'running' | 'succeeded' | 'failed'
const _jobs = ref([])
const _retries = new Map()   // job id → retry fn (kept outside the reactive ref so
                              // updating it doesn't trigger a render churn)

let _initialised = false
function _ensureInit() {
  if (_initialised) return
  _initialised = true

  ur.onSaveEvent(evt => {
    if (evt.type === 'queued') {
      _jobs.value.push({
        id: evt.id,
        resourceKey: evt.resourceKey,
        label: evt.label,
        status: 'queued',
        error: null,
        startedAt: null,
        endedAt: null,
      })
      return
    }

    const job = _jobs.value.find(j => j.id === evt.id)
    if (!job) return

    if (evt.type === 'started') {
      job.status = 'running'
      job.startedAt = Date.now()
    } else if (evt.type === 'succeeded') {
      job.status = 'succeeded'
      job.endedAt = Date.now()
      _retries.delete(evt.id)
      // Auto-clear after TTL so the UI flashes 'Saved ✓' then settles.
      setTimeout(() => {
        const idx = _jobs.value.findIndex(j => j.id === evt.id)
        if (idx !== -1) _jobs.value.splice(idx, 1)
      }, SUCCESS_TTL_MS)
    } else if (evt.type === 'failed') {
      job.status = 'failed'
      job.endedAt = Date.now()
      job.error = evt.error
      // Failed jobs stay visible until the user retries or dismisses.
    }
  })
}

/**
 * Background-save composable. Returns reactive job state + submit/retry/dismiss
 * actions. Safe to call from many components — they all share one queue, one
 * job list, and the same lifecycle events.
 */
export function useBackgroundSave() {
  _ensureInit()

  const queued    = computed(() => _jobs.value.filter(j => j.status === 'queued'))
  const running   = computed(() => _jobs.value.filter(j => j.status === 'running'))
  const succeeded = computed(() => _jobs.value.filter(j => j.status === 'succeeded'))
  const failed    = computed(() => _jobs.value.filter(j => j.status === 'failed'))
  const inFlight  = computed(() => queued.value.length + running.value.length > 0)
  const anySaving = computed(() => running.value.length > 0)

  /**
   * Submit a save task. Identical signature to `ur.enqueueSave` with one
   * extra parameter: `retry`. If `retry` is omitted, the original `task` fn
   * is captured and re-used on retry — so most callers won't pass it.
   *
   * @param {object} opts
   * @param {string} opts.resourceKey  Saves with the same key are serialised.
   * @param {() => Promise<any>} opts.task  Async save operation.
   * @param {string} [opts.label]  Human-readable label for UI.
   * @param {() => Promise<any>} [opts.retry]  Custom retry fn; defaults to `task`.
   * @returns {string} job id
   */
  function submit({ resourceKey, task, label = 'save', retry } = {}) {
    if (!resourceKey) throw new Error('useBackgroundSave.submit: resourceKey required')
    if (typeof task !== 'function') throw new Error('useBackgroundSave.submit: task must be a function')
    const id = ur.enqueueSave({ resourceKey, task, label })
    _retries.set(id, retry || task)
    return id
  }

  /**
   * Retry a failed job. Returns the new job id, or null if no retry fn was
   * captured (only happens if the original submit() pre-dates the listener
   * being initialised — should never happen in practice).
   */
  function retry(id) {
    const job = _jobs.value.find(j => j.id === id)
    if (!job) return null
    const retryFn = _retries.get(id)
    if (!retryFn) return null
    // Remove the failed job entry so the badge stops showing the old error
    const idx = _jobs.value.findIndex(j => j.id === id)
    if (idx !== -1) _jobs.value.splice(idx, 1)
    _retries.delete(id)
    return submit({
      resourceKey: job.resourceKey,
      task: retryFn,
      label: job.label,
      retry: retryFn,
    })
  }

  /**
   * Remove a job from the UI (typically a failed job after user acknowledges
   * the error). Does NOT cancel the underlying save — that's not safe given
   * the queue's serialised execution model.
   */
  function dismiss(id) {
    const idx = _jobs.value.findIndex(j => j.id === id)
    if (idx !== -1) _jobs.value.splice(idx, 1)
    _retries.delete(id)
  }

  return {
    submit,
    retry,
    dismiss,
    jobs:      _jobs,
    queued,
    running,
    succeeded,
    failed,
    inFlight,
    anySaving,
  }
}
