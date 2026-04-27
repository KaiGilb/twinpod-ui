<!-- UNIT_TYPE=Widget -->
<!--
  SessionCostGate.vue

  Displayed in the chat input area when the user has consumed their free trial
  (balance=0, trialUsed=true). Replaces the chat input until credits are purchased.

  Shows:
    - Clear message explaining the trial is over
    - BuyCreditsButton component so the user can purchase credits inline

  Evo3b addition:
    - Accepts trialActive (bool) and remainingMs (number) props.
    - When trialActive is true, shows a subtle countdown ("Free trial: M:SS remaining").
    - Countdown is hidden once the gate is shown (trialActive will be false by then).

  Mobile-first: full-width card, centred in the chat area, 375px viewport safe.
  All interactive elements meet the 44×44px minimum touch target (V.MobileUX).

  Spec: Evo3a.TrialSchemaAndGate
        Evo3b.TrialTimerAndTermination — trial countdown display
        V.MobileUX — 375px safe; 44×44px touch targets
        Accessibility — WCAG 2.1 AA; semantic HTML; aria-live for status message
-->

<script>
/**
 * Displayed when the user has no credits remaining and has used their free trial.
 * Replaces the chat input until the user purchases credits.
 *
 * Props:
 *   trialActive  {boolean} — true while the trial window is still open (pre-gate use only)
 *   remainingMs  {number}  — milliseconds remaining in the trial window
 *
 * Both props are optional. When provided they enable the countdown indicator;
 * the gate message is shown regardless.
 *
 * Emits no events — BuyCreditsButton handles the purchase redirect internally.
 *
 * @see Spec: Evo3a.TrialSchemaAndGate
 * @see Spec: Evo3b.TrialTimerAndTermination
 */
import { computed } from 'vue'
import BuyCreditsButton from './BuyCreditsButton.vue'

export default {
  name: 'SessionCostGate',
  components: { BuyCreditsButton },

  props: {
    /** True while the trial countdown is still running. */
    trialActive: {
      type: Boolean,
      default: false
    },
    /** Milliseconds remaining in the trial window. */
    remainingMs: {
      type: Number,
      default: 0
    }
  },

  setup(props) {
    /**
     * Format remainingMs as "M:SS" for display.
     * Used only when trialActive is true and the gate is not yet shown.
     */
    const formattedRemaining = computed(() => {
      const totalSeconds = Math.max(0, Math.ceil(props.remainingMs / 1000))
      const minutes = Math.floor(totalSeconds / 60)
      const seconds = totalSeconds % 60
      // Zero-pad seconds: "4:07" not "4:7"
      return `${minutes}:${seconds.toString().padStart(2, '0')}`
    })

    return { formattedRemaining }
  }
}
</script>

<template>
  <div class="cost-gate" role="region" aria-label="Free trial ended">

    <!--
      Countdown indicator — shown while the trial is still active (pre-expiry).
      Hidden once the gate appears (trialActive will be false at that point).
      Spec: Evo3b.TrialTimerAndTermination — subtle remaining-time display
      aria-live="polite" so screen readers announce the initial appearance.
    -->
    <p
      v-if="trialActive"
      class="cost-gate__countdown"
      aria-live="polite"
      aria-label="Free trial time remaining"
    >
      Free trial: {{ formattedRemaining }} remaining
    </p>

    <!--
      Status message — aria-live="polite" announces this to screen readers when it
      first appears so users who cannot see the UI are aware of the state change.
      Spec: Evo3a.TrialSchemaAndGate — "You've used your free trial" copy requirement
    -->
    <p
      class="cost-gate__message"
      role="status"
      aria-live="polite"
    >
      Tom's complementary consulting time has come to an end. For more advice and wisdom and to dive deeper into your projects, please contribute to this project.
    </p>

    <!--
      BuyCreditsButton inline — user can purchase without leaving the page.
      BuyCreditsButton handles its own loading and error states internally.
      Spec: Evo3a.TrialSchemaAndGate — "show the BuyCreditsButton component"
    -->
    <BuyCreditsButton />

  </div>
</template>

<style scoped>
/*
 * cost-gate — centred card replacing the chat input.
 * Mobile-first: full-width at 375px, max-width 480px so it doesn't stretch on desktop.
 * Spec: Evo3a.TrialSchemaAndGate — "full-width card, centred in the chat area, 375px safe"
 * V.MobileUX — no horizontal scroll, no fixed widths outside safe breakpoints.
 */
.cost-gate {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 0.75rem;
  width: 100%;
  max-width: 480px;
  margin: 0 auto;
  padding: 1rem;
  background: var(--color-surface-card);
  border: 1px solid var(--color-border-subtle);
  border-radius: 0.625rem;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.07);
}

/*
 * Countdown — subtle, muted; does not compete with the gate message.
 * Spec: Evo3b.TrialTimerAndTermination — "small text, muted colour, does not interfere"
 */
.cost-gate__countdown {
  font-size: 0.8125rem;
  color: var(--color-text-secondary);
  text-align: center;
  line-height: 1.4;
}

/*
 * Message text — clear, prominent, not an error (amber rather than red).
 * The user is being informed, not being penalised.
 */
.cost-gate__message {
  font-size: 0.9375rem;
  font-weight: 500;
  color: var(--color-text-primary);
  line-height: 1.45;
  text-align: center;
}
</style>
