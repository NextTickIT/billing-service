<script setup lang="ts">
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { setTheme, getTheme } from '../app/theme.js';

const { t } = useI18n();
const current = ref<'dark' | 'light'>(getTheme());

function toggle(): void {
  const next = current.value === 'dark' ? 'light' : 'dark';
  setTheme(next);
  current.value = next;
}
</script>

<template>
  <button class="theme-toggle" type="button" @click="toggle">
    {{ current === 'dark' ? t('common.theme.light') : t('common.theme.dark') }}
  </button>
</template>

<style scoped>
.theme-toggle {
  background: none;
  border: 1px solid var(--line-2);
  color: var(--dim);
  padding: 4px 10px;
  font-size: 12px;
  cursor: pointer;
  transition: color 0.15s, border-color 0.15s;
}

.theme-toggle:hover {
  color: var(--txt);
  border-color: var(--line);
}
</style>
