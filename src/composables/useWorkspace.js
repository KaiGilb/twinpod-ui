// UNIT_TYPE=Hook

/**
 * useWorkspace — shared document state stub for the twinpod-ui package.
 *
 * The full implementation lives in each app's own composables folder
 * (e.g. The Brain: src/composables/useWorkspace.js).
 * This stub satisfies the import in usePodWorkbook.js at the package level
 * so consumers that only use LoginView or other components do not fail to
 * resolve the module.
 *
 * Apps that use usePodWorkbook must override this by providing a real
 * useWorkspace() via their app's local composable (module-level singleton pattern).
 *
 * @returns {{ document: import('vue').Ref<string> }}
 */

import { ref } from 'vue'

// Module-level singleton so all callers within the package share one ref.
const _document = ref('')

export function useWorkspace() {
  return { document: _document }
}
