<!-- UNIT_TYPE=Widget -->
<!--
  LoginView.vue

  Login gate for The Brain.
  Shows the app title and a single "Connect to TwinPod" button that initiates the
  Solid OIDC redirect flow. Auth state is injected via provide/inject from App.vue.

  Spec: F.TwinPodLoginScreen — unauthenticated users see this view only.
        V.KaiIdentityConfidence — login must initiate OIDC redirect within 500ms.
        V.MobileUX — 44px min touch target on button; usable at 375px viewport.
  DSGN_16 — all colours via var(--color-*); no raw hex.
-->

<script setup>
/**
 * Login page for The Brain.
 * Shows a server selector (twinpod.eu / twinpod.us) and a "Connect" button
 * that initiates the Solid OIDC redirect flow against the chosen server.
 *
 * @see Spec: /Users/kaigilb/Library/Mobile Documents/iCloud~md~obsidian/Documents/Kai-Zen-Vault/5 - Project/The Brain/01Planning/TheBrain-Specs/
 */

import { ref, inject } from 'vue'

// Auth state and actions are provided by App.vue root component.
const { login, error, loading } = inject('auth')

// Primary TwinPod servers — clicking one connects immediately.
const SERVERS = [
  { label: 'twinpod.eu', url: 'https://twinpod.eu' },
  { label: 'twinpod.us', url: 'https://twinpod.us' }
]

// Additional servers revealed under "other".
const OTHER_SERVERS = [
  { label: 'gilb.com', url: 'https://gilb.com' },
  { label: 'demo.systemtwin.com', url: 'https://demo.systemtwin.com' }
]

const showOther = ref(false)
const customUrl = ref('')
// Track which URL is actively connecting so the right button shows a spinner.
const connectingUrl = ref('')

// Spec: F.TwinPodLoginScreen — initiates OIDC redirect to the given server URL.
function connect(url) {
  const target = url.trim()
  if (!target) return
  connectingUrl.value = target
  const redirectUrl = window.location.origin + import.meta.env.BASE_URL.replace(/\/$/, '')
  login(target, redirectUrl)
}
</script>

<template>
  <main class="login__root">
    <div class="login__card">
      <h1 class="login__title">
        Tom Gilb
        <span class="login__title-sub">Twin Consultant</span>
      </h1>
      <p class="login__subtitle">Connect your TwinPod to get started</p>

      <!-- Primary servers — each button connects immediately on click -->
      <div class="login__server-select login__server-select--primary" role="group" aria-label="Choose TwinPod server">
        <button
          v-for="s in SERVERS"
          :key="s.url"
          class="login__server-btn"
          :class="{ 'login__server-btn--active': connectingUrl === s.url }"
          type="button"
          :disabled="loading"
          @click="connect(s.url)"
        >
          <span v-if="connectingUrl === s.url">Connecting…</span>
          <span v-else>{{ s.label }}</span>
        </button>
      </div>

      <!-- "other" toggle link -->
      <button
        class="login__other-toggle"
        type="button"
        @click="showOther = !showOther"
        :aria-expanded="showOther"
      >other</button>

      <!-- Expanded: additional servers + custom URI field -->
      <div v-if="showOther" class="login__other">
        <div class="login__server-select" role="group" aria-label="Other servers">
          <button
            v-for="s in OTHER_SERVERS"
            :key="s.url"
            class="login__server-btn"
            :class="{ 'login__server-btn--active': connectingUrl === s.url }"
            type="button"
            :disabled="loading"
            @click="connect(s.url)"
          >
            <span v-if="connectingUrl === s.url">Connecting…</span>
            <span v-else>{{ s.label }}</span>
          </button>
        </div>

        <!-- Custom URL row -->
        <div class="login__custom-row">
          <input
            class="login__custom-url"
            type="url"
            placeholder="https://your-server.example.com"
            v-model="customUrl"
            aria-label="Custom TwinPod server URL"
            autocomplete="off"
            spellcheck="false"
            @keydown.enter="connect(customUrl)"
          />
          <button
            class="login__custom-connect"
            type="button"
            :disabled="loading || !customUrl.trim()"
            @click="connect(customUrl)"
          >
            <span v-if="connectingUrl === customUrl.trim()">…</span>
            <span v-else>Connect</span>
          </button>
        </div>
      </div>

      <!--
        Spec: F.TwinPodLoginScreen — show error if login setup fails before redirect.
        role="alert" announces the error immediately to screen readers (WCAG 2.1 AA).
        Only shown when error.value is non-null (e.g. invalid OIDC issuer).
      -->
      <p
        v-if="error"
        class="login__error"
        role="alert"
      >
        {{ error.message }}
      </p>
    </div>
  </main>
</template>

<style scoped>
/*
 * LoginView — mobile-first layout.
 * Base styles target the 375px viewport (MOBILE_01).
 * At ≥768px the card gets a bit more padding and a constrained max-width.
 */

.login__root {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 100dvh;
  padding: 2rem 1.5rem;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;

  /* Background hero image */
  background-image: url('/login-bg.jpg');
  background-size: cover;
  background-position: center center;
  background-repeat: no-repeat;
  background-color: #0a1220; /* fallback while image loads */
}

.login__card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1rem;
  width: 100%;
  max-width: 360px;

  /* Frosted glass card over the hero image */
  background: rgba(8, 16, 30, 0.72);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 1rem;
  padding: 2.5rem 2rem;
}

.login__title {
  font-size: 2rem;
  font-weight: 700;
  color: #ffffff;
  letter-spacing: 0.01em;
  text-align: center;
  margin: 0;
  line-height: 1.15;
}

/*
 * Sub-title on its own line, smaller font.
 * Replaces the previous " — Twin Consultant" inline notation, which was breaking
 * unpredictably between "Twin" and "Consultant" on narrow viewports.
 */
.login__title-sub {
  display: block;
  margin-top: 0.25rem;
  font-size: 1.25rem;
  font-weight: 500;
  letter-spacing: 0.02em;
  color: rgba(255, 255, 255, 0.85);
}

.login__subtitle {
  font-size: 1rem;
  color: rgba(255, 255, 255, 0.65);
  text-align: center;
  margin: 0;
}

/* Server selector — pill-style toggle */
.login__server-select {
  display: flex;
  width: 100%;
  border: 1px solid rgba(255, 255, 255, 0.18);
  border-radius: 0.5rem;
  overflow: hidden;
}

.login__server-btn {
  flex: 1;
  min-height: 44px;
  padding: 0.5rem 1rem;
  background: transparent;
  border: none;
  color: rgba(255, 255, 255, 0.55);
  font-size: 0.9375rem;
  font-weight: 500;
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}

.login__server-btn + .login__server-btn {
  border-left: 1px solid rgba(255, 255, 255, 0.18);
}

.login__server-btn--active {
  background: rgba(255, 255, 255, 0.12);
  color: #ffffff;
}

.login__server-btn:hover:not(.login__server-btn--active):not(:disabled) {
  background: rgba(255, 255, 255, 0.07);
  color: rgba(255, 255, 255, 0.8);
}

/* Primary server buttons (eu / us) — same colour as the old Connect button */
.login__server-select--primary .login__server-btn {
  background: var(--color-primary-dark);
  color: var(--color-surface-white);
  font-weight: 600;
}

.login__server-select--primary .login__server-btn:hover:not(:disabled) {
  filter: brightness(0.9);
  background: var(--color-primary-dark);
}

.login__server-select--primary .login__server-btn--active {
  filter: brightness(0.85);
}

/* "other" toggle link */
.login__other-toggle {
  background: none;
  border: none;
  padding: 0;
  color: rgba(255, 255, 255, 0.4);
  font-size: 0.8125rem;
  cursor: pointer;
  text-decoration: underline;
  text-underline-offset: 2px;
  transition: color 0.15s;
  align-self: center;
}

.login__other-toggle:hover {
  color: rgba(255, 255, 255, 0.7);
}

/* Container for the expanded other section */
.login__other {
  display: flex;
  flex-direction: column;
  gap: 0.625rem;
  width: 100%;
}

/* Custom URL row — input + inline Connect button */
.login__custom-row {
  display: flex;
  gap: 0.5rem;
  align-items: stretch;
}

.login__custom-url {
  flex: 1;
  min-height: 44px;
  padding: 0.5rem 0.875rem;
  background: rgba(255, 255, 255, 0.07);
  border: 1px solid rgba(255, 255, 255, 0.18);
  border-radius: 0.5rem;
  color: #ffffff;
  font-size: 0.875rem;
  box-sizing: border-box;
  outline: none;
  transition: border-color 0.15s;
}

.login__custom-url::placeholder {
  color: rgba(255, 255, 255, 0.3);
}

.login__custom-url:focus {
  border-color: rgba(255, 255, 255, 0.45);
}

.login__custom-connect {
  flex-shrink: 0;
  min-height: 44px;
  padding: 0.5rem 1rem;
  background: rgba(255, 255, 255, 0.12);
  border: 1px solid rgba(255, 255, 255, 0.18);
  border-radius: 0.5rem;
  color: #ffffff;
  font-size: 0.875rem;
  font-weight: 500;
  cursor: pointer;
  transition: background 0.15s;
  white-space: nowrap;
}

.login__custom-connect:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.2);
}

.login__custom-connect:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

/*
 * Error message — light variant so it's readable on the dark card.
 * Spec: WCAG 2.1 AA — error messages must be accessible to screen readers.
 */
.login__error {
  color: #fca5a5;
  background: rgba(220, 38, 38, 0.2);
  border: 1px solid rgba(220, 38, 38, 0.35);
  border-radius: 0.375rem;
  padding: 0.625rem 1rem;
  font-size: 0.875rem;
  width: 100%;
  text-align: left;
  margin: 0;
}

/* Desktop: slightly roomier card */
@media (min-width: 768px) {
  .login__card {
    gap: 1.25rem;
    padding: 3rem 2.5rem;
    max-width: 400px;
  }

  .login__title {
    font-size: 2.25rem;
  }

  .login__title-sub {
    font-size: 1.4rem;
  }

}
</style>
