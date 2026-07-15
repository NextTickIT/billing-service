<script setup lang="ts">
</script>

<template>
  <span class="spinner" aria-label="loading">
    <span class="spinner__frames">[<span class="spinner__dot">…</span>]</span>
  </span>
</template>

<style scoped>
.spinner {
  color: var(--dim);
  font-size: 13px;
}

.spinner__dot {
  display: inline-block;
  animation: blink 1s step-start infinite;
}

@keyframes blink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0; }
}
</style>
