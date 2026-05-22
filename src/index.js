// Composables
export { useBackgroundSave } from './composables/useBackgroundSave.js'
export { useCreditLedger } from './composables/useCreditLedger.js'
export { useTrial } from './composables/useTrial.js'
export { usePodWorkbook } from './composables/usePodWorkbook.js'
export {
  useSessionIndex,
  // Emergency hotfix round 2 (2026-05-14) — session-agnostic scratch-draft
  // helpers, exported so App.vue can drive the Layer 1 / Layer 2 watchers
  // without re-implementing the localStorage key contract.
  _writeScratchDraft,
  _readScratchDraft,
  _clearScratchDraft,
  // Test-only helpers exported here so the host-app vitest suite
  // (tomgilb-chat/src/composables/useSessionIndex.emergencySave.test.js)
  // can reset the module-level state and poke session-keyed backups
  // without subpath-import workarounds.
  _resetModuleStateForTesting,
  _writeLocalStorageBackup,
  _readLocalStorageBackup,
  _clearLocalStorageBackup
} from './composables/useSessionIndex.js'

// Components
export { default as LoginView } from './components/LoginView.vue'
export { default as SessionPanel } from './components/SessionPanel.vue'
export { default as BuyCreditsButton } from './components/BuyCreditsButton.vue'
export { default as SessionCostGate } from './components/SessionCostGate.vue'
export { default as SaveStatusBadge } from './components/SaveStatusBadge.vue'
export { default as InlineField } from './components/InlineField.vue'
