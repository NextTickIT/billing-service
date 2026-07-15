<script setup lang="ts">
interface Props {
  label: string;
  variant?: 'primary' | 'danger' | 'ghost';
  disabled?: boolean;
  loading?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  variant: 'primary',
  disabled: false,
  loading: false,
});

const emit = defineEmits<{ click: [] }>();

function onClick(): void {
  if (!props.disabled && !props.loading) emit('click');
}
</script>

<template>
  <button
    :class="['btn', `btn--${variant}`]"
    :disabled="disabled || loading"
    type="button"
    @click="onClick"
  >
    <span v-if="loading" class="btn__spinner" aria-hidden="true" />
    <span v-else>{{ label }}</span>
  </button>
</template>

<style scoped>
.btn {
  display: inline-flex;
  min-height: 36px;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 7px 16px;
  border: 1px solid var(--line);
  border-radius: 4px;
  background: var(--surface);
  color: var(--text);
  font-family: var(--sans);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s, color 0.15s;
  white-space: nowrap;
}

.btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.btn--primary {
  background: var(--green);
  border-color: var(--green);
  color: var(--bg);
  font-weight: 800;
}

.btn--primary:hover:not(:disabled) {
  background: var(--green-hover);
  border-color: var(--green-hover);
}

.btn--danger {
  background: transparent;
  border-color: var(--red);
  color: var(--red);
}

.btn--danger:hover:not(:disabled) {
  background: var(--red);
  color: var(--bg);
}

.btn--ghost {
  background: var(--surface);
  border-color: var(--line);
  color: var(--muted);
}

.btn--ghost:hover:not(:disabled) {
  color: var(--text);
  border-color: var(--line-2);
}

.btn__spinner {
  width: 14px;
  height: 14px;
  border: 2px solid currentColor;
  border-top-color: transparent;
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}
</style>
