<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';

type Locale = 'en' | 'ru' | 'uk';
const LOCALES: Locale[] = ['en', 'ru', 'uk'];

const { locale, t } = useI18n();

const current = computed(() => locale.value as Locale);

function cycle(): void {
  const idx = LOCALES.indexOf(current.value);
  const next = LOCALES[(idx + 1) % LOCALES.length] ?? 'en';
  locale.value = next;
  localStorage.setItem('lang', next);
}
</script>

<template>
  <button class="lang-switch" type="button" @click="cycle">
    {{ t(`common.lang.${current}`) }}
  </button>
</template>

<style scoped>
.lang-switch {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 5px 9px;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: 4px;
  color: var(--muted);
  font-family: var(--mono);
  font-size: 11px;
  letter-spacing: 0.04em;
  cursor: pointer;
  transition: color 0.15s, border-color 0.15s;
}

.lang-switch:hover {
  color: var(--green);
  border-color: var(--green);
}
</style>
