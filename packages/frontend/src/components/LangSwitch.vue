<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { setLocale } from '../i18n/index.js';

type Locale = 'en' | 'ru' | 'uk';
const LOCALES: Locale[] = ['en', 'ru', 'uk'];

const { locale, t } = useI18n();

const current = computed(() => locale.value as Locale);

function cycle(): void {
  const idx = LOCALES.indexOf(current.value);
  const next = LOCALES[(idx + 1) % LOCALES.length] ?? 'en';
  setLocale(next);
}
</script>

<template>
  <button class="lang-switch" type="button" @click="cycle">
    {{ t(`common.lang.${current}`) }}
  </button>
</template>

<style scoped>
.lang-switch {
  background: none;
  border: 1px solid var(--line-2);
  color: var(--dim);
  padding: 4px 10px;
  font-size: 12px;
  cursor: pointer;
  transition: color 0.15s, border-color 0.15s;
}

.lang-switch:hover {
  color: var(--txt);
  border-color: var(--line);
}
</style>
