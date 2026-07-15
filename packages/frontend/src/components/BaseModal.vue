<script setup lang="ts">
interface Props {
  open: boolean;
  title: string;
}

defineProps<Props>();

const emit = defineEmits<{ close: [] }>();
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="modal-overlay" @click.self="emit('close')">
      <div class="modal" role="dialog" :aria-label="title">
        <div class="modal__header">
          <span class="modal__title">{{ title }}</span>
          <button class="modal__close" type="button" @click="emit('close')">×</button>
        </div>
        <div class="modal__body">
          <slot />
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.modal {
  background: var(--panel);
  border: 1px solid var(--line);
  min-width: 340px;
  max-width: 560px;
  width: 100%;
}

.modal__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  border-bottom: 1px solid var(--line);
  background: var(--panel-2);
}

.modal__title {
  color: var(--green);
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
}

.modal__close {
  background: none;
  border: none;
  color: var(--dim);
  font-size: 18px;
  cursor: pointer;
  line-height: 1;
  padding: 0 2px;
}

.modal__close:hover {
  color: var(--txt);
}

.modal__body {
  padding: 16px;
}
</style>
