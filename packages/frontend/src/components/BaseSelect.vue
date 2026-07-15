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
  padding: 6px 10px;
  background: var(--bg);
  border: 1px solid var(--line);
  color: var(--txt);
  font-size: 13px;
  outline: none;
  cursor: pointer;
  transition: border-color 0.15s;
}

.base-select:focus {
  border-color: var(--green);
}

.base-select:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
</style>
