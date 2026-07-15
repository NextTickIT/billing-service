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
          <div class="modal__dots">
            <span class="r" />
            <span class="y" />
            <span class="g" />
          </div>
          <span class="modal__title">{{ title }}</span>
          <button class="modal__close" type="button" aria-label="Close" @click="emit('close')">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <path d="M1 1l10 10M11 1L1 11" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
            </svg>
          </button>
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
  background: rgba(0, 0, 0, 0.55);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  backdrop-filter: blur(2px);
}

.modal {
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: 6px;
  min-width: 340px;
  max-width: 560px;
  width: 100%;
  overflow: hidden;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
}

.modal__header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 16px;
  border-bottom: 1px solid var(--line);
  background: var(--surface-2);
}

.modal__dots {
  display: flex;
  gap: 5px;
}

.modal__dots span {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  border: 1px solid var(--line-2);
}

.modal__dots .r { background: var(--dot-r); }
.modal__dots .y { background: var(--dot-y); }
.modal__dots .g { background: var(--dot-g); }

.modal__title {
  color: var(--muted);
  font-family: var(--mono);
  font-size: 11px;
  letter-spacing: 0.04em;
  flex: 1;
}

.modal__close {
  background: none;
  border: none;
  color: var(--dim);
  cursor: pointer;
  padding: 2px;
  line-height: 1;
  border-radius: 2px;
  transition: color 0.15s;
}

.modal__close:hover {
  color: var(--text);
}

.modal__body {
  padding: 20px;
}
</style>
