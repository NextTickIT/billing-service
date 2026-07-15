<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';

type Locale = 'uk' | 'en' | 'ru';
const LOCALES: Locale[] = ['uk', 'en', 'ru'];

const { locale } = useI18n();
const current = computed(() => locale.value as Locale);

function select(l: Locale): void {
  locale.value = l;
  localStorage.setItem('lang', l);
}
</script>

<template>
  <div class="lang-switch">
    <button
      v-for="l in LOCALES"
      :key="l"
      class="ls-opt"
      :class="{ on: current === l }"
      type="button"
      @click="select(l)"
    >
      {{ l.toUpperCase() }}
    </button>
  </div>
</template>

<style scoped>
.lang-switch {
  display: inline-flex;
  gap: 2px;
}
.ls-opt {
  font-family: var(--mono);
  font-size: 12px;
  letter-spacing: 0.04em;
  line-height: 1;
  padding: 5px 7px;
  border-radius: 2px;
  color: var(--muted);
  background: transparent;
  border: 1px solid transparent;
  opacity: 0.75;
  cursor: pointer;
  transition:
    opacity 0.15s,
    color 0.15s,
    border-color 0.15s;
}
.ls-opt:hover,
.ls-opt.on {
  opacity: 1;
  color: var(--green);
  border-color: var(--green);
}
</style>
