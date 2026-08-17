<script setup lang="ts">
interface Props {
  modelValue: string;
  placeholder?: string;
  disabled?: boolean;
  type?: string;
}

withDefaults(defineProps<Props>(), {
  placeholder: '',
  disabled: false,
  type: 'text',
});

const emit = defineEmits<{ 'update:modelValue': [value: string] }>();
</script>

<template>
  <input
    :value="modelValue"
    :placeholder="placeholder"
    :disabled="disabled"
    :type="type"
    class="base-input"
    @input="emit('update:modelValue', ($event.target as HTMLInputElement).value)"
  />
</template>

<style scoped>
.base-input {
  width: 100%;
  padding: 8px 12px;
  background: var(--bg);
  border: 1px solid var(--line);
  border-radius: 4px;
  color: var(--text);
  font-family: var(--sans);
  font-size: 13px;
  outline: none;
  transition: border-color 0.15s;
}

.base-input::placeholder {
  color: var(--dim);
}

.base-input:focus {
  border-color: var(--green);
}

.base-input:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
</style>
