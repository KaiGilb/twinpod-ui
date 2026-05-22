<!-- UNIT_TYPE=Widget -->
<!--
  InlineField — always-editable text input styled as a profile field.

  Pattern (per Reference_Code_TwinPod-OptimisticSaveQueue):
    - Field is always an <input> (no separate "edit mode").
    - Read-state appearance: borderless, blends with surrounding text.
    - Hover / focus: subtle border + background to signal interactivity.
    - On blur, if the value changed, emits `commit` with the new value.
      Parent enqueues a background save via useBackgroundSave.submit({...}).

  Two-way binding via `v-model` is supported AND the `commit` event fires
  only on blur (debounced to save-on-leave, not save-on-keystroke). Use
  `commit` to trigger the save; `v-model` to keep local state in sync.

  Props:
    modelValue (string)   the canonical value
    label     (string)    field label, shown above the input
    type      (string)    input type — 'text' (default), 'email', 'tel', etc.
    placeholder (string)  placeholder text shown when value is empty
    autocomplete (string) HTML autocomplete hint
    inputmode (string)    iOS soft-keyboard hint — 'email', 'tel', 'numeric', …

  Emits:
    update:modelValue (string)   per-keystroke (v-model)
    commit            (string)   on blur, only if value changed since focus
-->
<script setup>
import { ref, watch } from 'vue'

const props = defineProps({
  modelValue: { type: String, default: '' },
  label:       { type: String, required: true },
  type:        { type: String, default: 'text' },
  placeholder: { type: String, default: '' },
  autocomplete: { type: String, default: 'off' },
  inputmode:   { type: String, default: undefined },
})
const emit = defineEmits(['update:modelValue', 'commit'])

const local   = ref(props.modelValue)
const focused = ref(false)
let valueOnFocus = ''   // captured at focus-in so blur compares against pre-edit value

// Keep local in sync with external changes while NOT focused — so an optimistic
// store update from somewhere else doesn't stomp the user's in-progress edit.
watch(() => props.modelValue, v => { if (!focused.value) local.value = v })

function onFocus() {
  focused.value = true
  valueOnFocus = local.value
}

function onBlur() {
  focused.value = false
  if (local.value !== valueOnFocus) {
    emit('update:modelValue', local.value)
    emit('commit', local.value)
  }
}

function onInput(e) {
  // Forward each keystroke for v-model compatibility, but DON'T emit `commit`
  // here — commit fires only on blur per the inline-save pattern.
  local.value = e.target.value
  emit('update:modelValue', local.value)
}
</script>

<template>
  <div class="tpu-inline-field" :class="{ 'tpu-inline-field--focused': focused }">
    <label class="tpu-inline-field__label">{{ label }}</label>
    <input
      class="tpu-inline-field__input"
      :type="type"
      :placeholder="placeholder"
      :autocomplete="autocomplete"
      :inputmode="inputmode"
      :value="local"
      @input="onInput"
      @focus="onFocus"
      @blur="onBlur"
    />
  </div>
</template>

<style scoped>
.tpu-inline-field {
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
}

.tpu-inline-field__label {
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--color-text-secondary, #6b7280);
}

.tpu-inline-field__input {
  font-size: 1rem;
  font-family: inherit;
  color: var(--color-text-primary, #111827);
  padding: 0.5rem 0.625rem;
  border: 1px solid transparent;
  border-radius: 0.375rem;
  background: transparent;
  width: 100%;
  min-height: 44px;        /* iOS tap-target minimum */
  box-sizing: border-box;
  transition: background 120ms ease, border-color 120ms ease;
}

.tpu-inline-field__input:hover {
  background: var(--color-surface-hover, rgba(0, 0, 0, 0.04));
}

.tpu-inline-field__input:focus {
  outline: none;
  border-color: var(--color-primary, #3b82f6);
  background: var(--color-surface-card, #fff);
}

.tpu-inline-field__input::placeholder {
  color: var(--color-text-muted, #9ca3af);
  font-style: italic;
}
</style>
