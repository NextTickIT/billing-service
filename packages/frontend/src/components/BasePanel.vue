<script setup lang="ts">
defineProps<{
  title?: string;
}>();
</script>

<template>
  <div class="panel">
    <div v-if="title" class="panel__header">
      <span class="panel__title">{{ title }}</span>
    </div>
    <div class="panel__body">
      <slot />
    </div>
  </div>
</template>

<style scoped>
.panel {
  background: var(--panel);
  border: 1px solid var(--line);
}

.panel__header {
  padding: 8px 14px;
  border-bottom: 1px solid var(--line);
  background: var(--panel-2);
}

.panel__title {
  color: var(--green);
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
}

.panel__body {
  padding: 14px;
}
</style>
