<script setup lang="ts">
defineProps<{
  title?: string;
}>();
</script>

<template>
  <div class="panel">
    <div v-if="title || $slots['actions']" class="panel__header">
      <span v-if="title" class="panel__title">{{ title }}</span>
      <div v-if="$slots['actions']" class="panel__actions">
        <slot name="actions" />
      </div>
    </div>
    <div class="panel__body">
      <slot />
    </div>
  </div>
</template>

<style scoped>
.panel {
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: 6px;
  overflow: hidden;
}

.panel__header {
  display: flex;
  align-items: center;
  padding: 10px 16px;
  border-bottom: 1px solid var(--line);
  background: var(--surface-2);
}

.panel__title {
  color: var(--muted);
  font-family: var(--mono);
  font-size: 11px;
  letter-spacing: 0.04em;
}

.panel__actions {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 8px;
}

.panel__body {
  padding: 20px;
}
</style>
