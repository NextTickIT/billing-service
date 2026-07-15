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
    <span v-if="loading" class="btn__spinner">[…]</span>
    <span v-else>{{ label }}</span>
  </button>
</template>

<style scoped>
.btn {
  padding: 6px 14px;
  border: 1px solid var(--line);
  background: transparent;
  color: var(--txt);
  font-size: 13px;
  cursor: pointer;
  transition: color 0.15s, border-color 0.15s;
}

.btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.btn--primary {
  border-color: var(--green);
  color: var(--green);
}

.btn--primary:hover:not(:disabled) {
  color: var(--green-hover);
  border-color: var(--green-hover);
}

.btn--danger {
  border-color: var(--red);
  color: var(--red);
}

.btn--danger:hover:not(:disabled) {
  opacity: 0.8;
}

.btn--ghost {
  border-color: var(--line-2);
  color: var(--dim);
}

.btn--ghost:hover:not(:disabled) {
  color: var(--txt);
  border-color: var(--line-2);
}

.btn__spinner {
  color: var(--dim);
}
</style>
