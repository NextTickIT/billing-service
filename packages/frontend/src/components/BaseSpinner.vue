<script setup lang="ts">
</script>

<template>
  <span class="spinner" role="status" aria-label="loading">
    <span class="spinner__ring" />
  </span>
</template>

<style scoped>
.spinner {
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.spinner__ring {
  display: block;
  width: 20px;
  height: 20px;
  border: 2px solid var(--line);
  border-top-color: var(--green);
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}
</style>
