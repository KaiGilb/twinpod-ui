<!-- UNIT_TYPE=Widget -->
<!--
  BuyCreditsButton.vue

  Three credit bundle purchase buttons — one per Stripe bundle.
  Calls startCheckout(priceId) from useCreditLedger on click,
  which redirects the browser to the Stripe-hosted Checkout page.

  Bundles:
    Starter  — €5  / 500 credits
    Standard — €20 / 2,000 credits
    Power    — €50 / 5,000 credits

  Mobile-first. Respects existing design tokens.
  Minimum touch target: 44×44px per V.MobileUX.

  Spec: 3P.F.ContributionFlow — initiates the Stripe Checkout purchase round-trip
        3P.V.ContributionEventCompletionRate — button click is the entry point
-->

<script>
/**
 * Displays three credit bundle purchase buttons.
 * Each button shows: bundle name, EUR price, credit count.
 *
 * @prop {boolean} loading - true while a checkout is in progress (disables all buttons)
 * @prop {string|null} error - error message from useCreditLedger (displayed inline)
 *
 * Emits no events — side effects happen via startCheckout redirect.
 *
 * @see Spec: 3P.F.ContributionFlow — BuyCreditsButton is the purchase entry point
 */

import { inject } from 'vue'
import { useCreditLedger } from '../composables/useCreditLedger.js'

// Bundle definitions — match the STRIPE_PRICE_IDS_JSON secrets exactly.
// Price IDs are injected via 'creditBundles' provide from App.vue so they
// can be driven by the env var rather than hardcoded here.
// Fallback to hardcoded labels/prices for display (these are static UX strings,
// not the Stripe price IDs themselves).
const BUNDLES = [
  { key: 'starter',  label: 'Starter',  eur: 5,  credits: 500 },
  { key: 'standard', label: 'Standard', eur: 20, credits: 2000 },
  { key: 'power',    label: 'Power',    eur: 50, credits: 5000 }
]

export default {
  name: 'BuyCreditsButton',

  props: {
    /** Disables all buttons while a checkout redirect is in progress. */
    loading: {
      type: Boolean,
      default: false
    }
  },

  setup() {
    const { startCheckout, loading: checkoutLoading, error } = useCreditLedger()

    // Bundle price IDs provided by App.vue — maps bundle key to Stripe priceId string.
    // If not provided (e.g. in tests), buttons show but clicking logs a warning.
    const bundlePriceIds = inject('bundlePriceIds', {})

    /**
     * Handle a bundle button click — look up the Stripe price ID and call startCheckout.
     *
     * @param {string} bundleKey - 'starter' | 'standard' | 'power'
     */
    async function onBuyClick(bundleKey) {
      const priceId = bundlePriceIds[bundleKey]
      if (!priceId) {
        console.error('[BuyCreditsButton] No priceId for bundle:', bundleKey)
        return
      }
      await startCheckout(priceId)
    }

    return {
      BUNDLES,
      checkoutLoading,
      error,
      onBuyClick
    }
  }
}
</script>

<template>
  <div class="buy-credits" role="group" aria-label="Buy credits">

    <!-- Error message — shown when checkout fails -->
    <p
      v-if="error"
      class="buy-credits__error"
      role="alert"
      aria-live="assertive"
    >
      {{ error }}
    </p>

    <!-- Bundle buttons -->
    <div class="buy-credits__buttons">
      <button
        v-for="bundle in BUNDLES"
        :key="bundle.key"
        type="button"
        class="buy-credits__btn"
        :disabled="checkoutLoading || loading"
        :aria-disabled="checkoutLoading || loading"
        :aria-label="`Buy ${bundle.label} bundle — €${bundle.eur} for ${bundle.credits.toLocaleString()} credits`"
        @click="onBuyClick(bundle.key)"
      >
        <span class="buy-credits__name">{{ bundle.label }}</span>
        <span class="buy-credits__price">€{{ bundle.eur }}</span>
        <span class="buy-credits__credits">{{ bundle.credits.toLocaleString() }} credits</span>
      </button>
    </div>

  </div>
</template>

<style scoped>
/*
 * buy-credits — wrapper for bundle buttons
 * Mobile-first: stacked column by default, row on wider screens.
 * V.MobileUX — 44px min touch target on all buttons.
 */
.buy-credits {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.buy-credits__buttons {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

@media (min-width: 480px) {
  .buy-credits__buttons {
    flex-direction: row;
    flex-wrap: wrap;
  }
}

/*
 * Bundle button — shows name, price, and credit count.
 * min-height: 44px satisfies V.MobileUX touch target requirement.
 */
.buy-credits__btn {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 0.1rem;
  padding: 0.5rem 0.75rem;
  min-height: 44px;
  min-width: 120px;
  border: 1.5px solid var(--color-border-default);
  border-radius: 0.5rem;
  background: var(--color-surface-card);
  color: var(--color-text-primary);
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
  text-align: left;
  flex: 1;
}

.buy-credits__btn:hover:not(:disabled) {
  border-color: var(--color-primary);
  background: var(--color-surface-input);
}

.buy-credits__btn:focus-visible {
  outline: 2px solid var(--color-border-active);
  outline-offset: 2px;
}

.buy-credits__btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.buy-credits__name {
  font-size: 0.8125rem;
  font-weight: 600;
  color: var(--color-text-primary);
}

.buy-credits__price {
  font-size: 1rem;
  font-weight: 700;
  color: var(--color-primary);
}

.buy-credits__credits {
  font-size: 0.75rem;
  color: var(--color-text-secondary);
}

/* Error message styling — matches existing app__pod-error pattern */
.buy-credits__error {
  padding: 0.375rem 0.5rem;
  background: var(--color-error-light);
  color: var(--color-error-dark);
  font-size: 0.8125rem;
  border-radius: 0.375rem;
  border: 1px solid var(--color-error-light);
}
</style>
