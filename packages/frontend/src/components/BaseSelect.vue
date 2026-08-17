<script setup lang="ts">
interface Option {
  value: string | number;
  label: string;
}

interface Props {
  modelValue: string | number;
  options: Option[];
  disabled?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  disabled: false,
});

const emit = defineEmits<{ 'update:modelValue': [value: string | number] }>();

function onChange(e: Event): void {
  const target = e.target as HTMLSelectElement;
  const match = props.options.find((o) => String(o.value) === target.value);
  emit('update:modelValue', match !== undefined ? match.value : target.value);
}
</script>

<template>
  <select
    :value="String(modelValue)"
    :disabled="disabled"
    class="base-select"
    @change="onChange"
  >
    <option
      v-for="opt in options"
      :key="String(opt.value)"
      :value="String(opt.value)"
    >
      {{ opt.label }}
    </option>
  </select>
</template>

<style scoped>
.base-select {
  width: 100%;
  padding: 8px 12px;
  background: var(--bg);
  border: 1px solid var(--line);
  border-radius: 4px;
  color: var(--text);
  font-family: var(--sans);
  font-size: 13px;
  outline: none;
  cursor: pointer;
  transition: border-color 0.15s;
  appearance: none;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'%3E%3Cpath d='M1 1l5 5 5-5' stroke='%235d6469' stroke-width='1.5' fill='none' stroke-linecap='round'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 12px center;
  padding-right: 32px;
}

.base-select:focus {
  border-color: var(--green);
}

.base-select:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
</style>
