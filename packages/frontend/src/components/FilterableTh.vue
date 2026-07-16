<script setup lang="ts">
import { ref, computed } from 'vue';

// One column header shared by every data table: a label plus a funnel that
// reveals an id filter. Owning the open/clear state here is what keeps the
// Payments and Quarantine headers from drifting apart.
const props = defineProps<{
  label: string;
  modelValue: string;
  placeholder?: string;
}>();
const emit = defineEmits<{ 'update:modelValue': [value: string] }>();

const open = ref(false);
const value = computed({
  get: () => props.modelValue,
  set: (v: string) => emit('update:modelValue', v),
});

function clear(): void {
  value.value = '';
  open.value = false;
}
</script>

<template>
  <th class="th-filter">
    <div class="th-filter__row">
      <span>{{ label }}</span>
      <button
        type="button"
        class="filter-icon"
        :class="{ 'filter-icon--active': modelValue }"
        :aria-label="label"
        @click="open = !open"
      >
        <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
          <path fill="currentColor" d="M0.5 1.5h15l-6 7v5l-3 1.5v-6.5l-6-7z" />
        </svg>
      </button>
    </div>
    <div v-if="open" class="th-filter__pop">
      <input
        v-model="value"
        class="th-filter__input"
        type="text"
        :placeholder="placeholder ?? label"
      />
      <button
        v-if="modelValue"
        type="button"
        class="filter-clear"
        @click="clear"
      >
        ×
      </button>
    </div>
  </th>
</template>

<style scoped>
.th-filter { position: relative; }
.th-filter__row { display: flex; align-items: center; gap: 6px; }
.filter-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 2px;
  border: 0;
  background: transparent;
  color: var(--dim);
  cursor: pointer;
  border-radius: 2px;
}
.filter-icon:hover,
.filter-icon--active { color: var(--green); }
.th-filter__pop {
  position: absolute;
  z-index: 20;
  top: 100%;
  left: 0;
  margin-top: 4px;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px;
  border: 1px solid var(--line);
  background: var(--surface);
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.25);
}
.th-filter__input {
  width: 200px;
  padding: 6px 8px;
  border: 1px solid var(--line);
  background: var(--bg-2);
  color: var(--text);
  font-family: var(--mono);
  font-size: 12px;
  text-transform: none;
}
.th-filter__input:focus { outline: none; border-color: var(--green); }
.filter-clear {
  border: 0;
  background: transparent;
  color: var(--dim);
  cursor: pointer;
  font-size: 16px;
  line-height: 1;
  padding: 0 4px;
}
.filter-clear:hover { color: var(--red); }
</style>
