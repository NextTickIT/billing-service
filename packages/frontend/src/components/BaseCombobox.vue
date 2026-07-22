<script setup lang="ts">
import { ref, computed, watch } from 'vue';

interface Option {
  value: string;
  label: string;
}

interface Props {
  modelValue: string;
  options: Option[];
  placeholder?: string;
  disabled?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  placeholder: '',
  disabled: false,
});

const emit = defineEmits<{ 'update:modelValue': [value: string] }>();

const open = ref(false);
const query = ref('');
const active = ref(0);

const selectedLabel = computed(() => {
  const match = props.options.find((o) => o.value === props.modelValue);
  return match?.label ?? '';
});

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase();
  if (!q) return props.options;
  return props.options.filter((o) => o.label.toLowerCase().includes(q));
});

// While closed the field mirrors the current selection; opening starts an empty
// typeahead so the operator filters from the full list.
watch(open, (isOpen) => {
  query.value = isOpen ? '' : query.value;
  active.value = 0;
});
watch(filtered, () => {
  active.value = 0;
});

function displayValue(): string {
  return open.value ? query.value : selectedLabel.value;
}

function select(option: Option): void {
  emit('update:modelValue', option.value);
  open.value = false;
}

function onFocus(): void {
  if (!props.disabled) open.value = true;
}

function onInput(e: Event): void {
  query.value = (e.target as HTMLInputElement).value;
  open.value = true;
}

function move(delta: number): void {
  const count = filtered.value.length;
  if (count === 0) return;
  active.value = (active.value + delta + count) % count;
}

function onEnter(): void {
  const option = filtered.value[active.value];
  if (option) select(option);
}

function close(): void {
  open.value = false;
}
</script>

<template>
  <div class="combo" @focusout="close">
    <input
      class="combo__input"
      :value="displayValue()"
      :placeholder="placeholder"
      :disabled="disabled"
      autocomplete="off"
      @focus="onFocus"
      @input="onInput"
      @keydown.down.prevent="move(1)"
      @keydown.up.prevent="move(-1)"
      @keydown.enter.prevent="onEnter"
      @keydown.esc="close"
    />
    <ul v-if="open && !disabled" class="combo__list">
      <li
        v-for="(opt, i) in filtered"
        :key="opt.value"
        :class="['combo__item', { 'combo__item--active': i === active }]"
        @mousedown.prevent="select(opt)"
        @mouseenter="active = i"
      >
        {{ opt.label }}
      </li>
      <li v-if="filtered.length === 0" class="combo__empty">
        <slot name="empty" />
      </li>
    </ul>
  </div>
</template>

<style scoped>
.combo {
  position: relative;
  width: 100%;
}

.combo__input {
  width: 100%;
  padding: 8px 12px;
  background: var(--bg);
  border: 1px solid var(--line);
  border-radius: 4px;
  color: var(--text);
  font-family: var(--sans);
  font-size: 13px;
  outline: none;
  cursor: text;
  transition: border-color 0.15s;
  box-sizing: border-box;
}

.combo__input::placeholder {
  color: var(--dim);
}

.combo__input:focus {
  border-color: var(--green);
}

.combo__input:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.combo__list {
  position: absolute;
  z-index: 20;
  top: calc(100% + 2px);
  left: 0;
  right: 0;
  margin: 0;
  padding: 4px 0;
  list-style: none;
  max-height: 200px;
  overflow-y: auto;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: 4px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
}

.combo__item {
  padding: 7px 12px;
  color: var(--text);
  font-size: 13px;
  cursor: pointer;
}

.combo__item--active {
  background: var(--surface-2);
  color: var(--green);
}

.combo__empty {
  padding: 7px 12px;
  color: var(--dim);
  font-size: 13px;
}
</style>
