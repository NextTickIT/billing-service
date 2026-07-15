<script setup lang="ts">
defineProps<{
  title?: string;
}>();
</script>

<template>
  <div class="panel">
    <div v-if="title" class="panel__header">
      <div class="panel__dots">
        <span class="r" />
        <span class="y" />
        <span class="g" />
      </div>
      <span class="panel__title">{{ title }}</span>
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
  gap: 10px;
  padding: 10px 16px;
  border-bottom: 1px solid var(--line);
  background: var(--surface-2);
}

.panel__dots {
  display: flex;
  gap: 5px;
}

.panel__dots span {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  border: 1px solid var(--line-2);
}

.panel__dots .r { background: var(--dot-r); }
.panel__dots .y { background: var(--dot-y); }
.panel__dots .g { background: var(--dot-g); }

.panel__title {
  color: var(--muted);
  font-family: var(--mono);
  font-size: 11px;
  letter-spacing: 0.04em;
}

.panel__body {
  padding: 20px;
}
</style>
