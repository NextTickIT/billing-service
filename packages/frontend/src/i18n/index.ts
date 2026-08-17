import { createI18n } from 'vue-i18n';
import en from './locales/en.js';
import ru from './locales/ru.js';
import uk from './locales/uk.js';

function detectLocale(): string {
  const saved = localStorage.getItem('lang');
  if (saved === 'en' || saved === 'ru' || saved === 'uk') return saved;
  const nav = navigator.language.toLowerCase();
  if (nav.startsWith('uk')) return 'uk';
  if (nav.startsWith('ru')) return 'ru';
  return 'en';
}

export const i18n = createI18n({
  legacy: false,
  locale: detectLocale(),
  fallbackLocale: false,
  messages: { en, ru, uk },
  missingWarn: false,
  fallbackWarn: false,
});

