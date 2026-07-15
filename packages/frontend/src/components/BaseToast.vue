<script setup lang="ts">
interface Props {
  message: string;
  type?: 'success' | 'error' | 'info';
  visible: boolean;
}

withDefaults(defineProps<Props>(), {
  type: 'info',
});
</script>

<template>
  <Teleport to="body">
    <Transition name="toast">
      <div v-if="visible" :class="['toast', `toast--${type}`]" role="alert">
        {{ message }}
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.toast {
  position: fixed;
  bottom: 20px;
  right: 20px;
  padding: 10px 16px;
  border: 1px solid var(--line);
  background: var(--panel);
  color: var(--txt);
  font-size: 13px;
  z-index: 2000;
  max-width: 360px;
}

.toast--success {
  border-color: var(--green);
  color: var(--green);
}

.toast--error {
  border-color: var(--red);
  color: var(--red);
}

.toast--info {
  border-color: var(--cyan);
  color: var(--cyan);
}

.toast-enter-active,
.toast-leave-active {
  transition: opacity 0.2s, transform 0.2s;
}

.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateY(8px);
}
</style>
