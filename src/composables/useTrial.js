// UNIT_TYPE=Hook

/**
 * useTrial — manages the client-side free trial countdown timer.
 *
 * Watches trialStartedAt; when it becomes non-null, computes the remaining
 * duration and fires a setTimeout for that duration. If the trial has already
 * elapsed when the composable mounts, onExpire is called immediately.
 *
 * Exposes trialActive and remainingMs for optional UI display.
 *
 * @param {object} options
 * @param {import('vue').Ref<string|null>} options.trialStartedAt
 *   ISO timestamp when the trial started. Null until trial begins.
 * @param {() => void} options.onExpire
 *   Called when the 5-minute trial window closes. May be called immediately
 *   on mount if the trial already elapsed before the component was created.
 *
 * @returns {{
 *   trialActive:  import('vue').Ref<boolean>,
 *   remainingMs:  import('vue').Ref<number>
 * }}
 *
 * Preconditions: Call inside a Vue component setup() or a composable that runs
 *   during component setup so onUnmounted can clean up timers.
 * Errors: None exposed — timer errors are silent (no UI impact if a timer fires late).
 *
 * @example
 * const { trialActive, remainingMs } = useTrial({
 *   trialStartedAt: creditTrialStartedAt,
 *   onExpire: () => { noCredits.value = true }
 * })
 *
 * Spec: Evo3b.TrialTimerAndTermination
 */

import { ref, watch, onUnmounted } from 'vue'

// Mirrors TRIAL_DURATION_MINUTES in the Worker (worker/src/index.js).
// Keep in sync manually when the Worker constant changes.
const TRIAL_DURATION_MINUTES = 10
const TRIAL_DURATION_MS = TRIAL_DURATION_MINUTES * 60 * 1000

export function useTrial({ trialStartedAt, onExpire }) {
  // --- State ---

  // True while the trial is running (started but not yet expired)
  const trialActive = ref(false)

  // Milliseconds remaining in the trial window; updated every second while active
  const remainingMs = ref(0)

  // --- Timer handles ---

  // setTimeout handle for the expiry callback
  let expiryTimer = null

  // setInterval handle for the per-second remainingMs update
  let tickInterval = null

  // --- Internal helpers ---

  /**
   * Clear both the expiry timer and the tick interval.
   * Called on unmount and before re-arming when trialStartedAt changes.
   */
  function clearTimers() {
    if (expiryTimer !== null) {
      clearTimeout(expiryTimer)
      expiryTimer = null
    }
    if (tickInterval !== null) {
      clearInterval(tickInterval)
      tickInterval = null
    }
  }

  /**
   * Arm the countdown from a known trialStartedAt ISO string.
   * Computes remaining ms; calls onExpire immediately if already elapsed,
   * otherwise sets the expiry timer and starts the tick interval.
   *
   * @param {string} ts - ISO timestamp when the trial started
   */
  function armTimer(ts) {
    clearTimers()

    const elapsed = Date.now() - Date.parse(ts)
    const remaining = TRIAL_DURATION_MS - elapsed

    if (remaining <= 0) {
      // Trial already over — expire immediately
      trialActive.value = false
      remainingMs.value = 0
      onExpire()
      return
    }

    // Trial is active — set countdown state
    trialActive.value = true
    remainingMs.value = remaining

    // Tick every second so the UI can show a live countdown
    tickInterval = setInterval(() => {
      const r = TRIAL_DURATION_MS - (Date.now() - Date.parse(ts))
      if (r <= 0) {
        // Interval fired just before the expiry timer — clamp to zero
        remainingMs.value = 0
      } else {
        remainingMs.value = r
      }
    }, 1000)

    // Single expiry callback at the exact remaining duration
    expiryTimer = setTimeout(() => {
      clearTimers()
      trialActive.value = false
      remainingMs.value = 0
      onExpire()
    }, remaining)
  }

  // --- Watch for trialStartedAt ---

  // Arm the timer as soon as trialStartedAt is set (or on mount if already set).
  // immediate: true handles the reload-mid-trial case where trialStartedAt is
  // already populated when the composable is first created.
  watch(
    trialStartedAt,
    (ts) => {
      if (!ts) return
      armTimer(ts)
    },
    { immediate: true }
  )

  // --- Cleanup ---

  onUnmounted(() => {
    clearTimers()
  })

  return { trialActive, remainingMs }
}
