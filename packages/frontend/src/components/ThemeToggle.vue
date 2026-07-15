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
  <button class="theme-toggle" type="button" :aria-label="current === 'dark' ? t('common.theme.light') : t('common.theme.dark')" @click="toggle">
    <svg v-if="current === 'dark'" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="5"/>
      <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/>
    </svg>
    <svg v-else width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/>
    </svg>
  </button>
</template>

<style scoped>
.theme-toggle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  padding: 0;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: 4px;
  color: var(--muted);
  cursor: pointer;
  transition: color 0.15s, border-color 0.15s;
}

.theme-toggle:hover {
  color: var(--green);
  border-color: var(--green);
}
</style>
