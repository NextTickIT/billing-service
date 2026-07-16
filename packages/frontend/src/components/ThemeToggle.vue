<script setup lang="ts">
import { setTheme, getTheme } from '@/app/theme.js';

function toggle(): void {
  setTheme(getTheme() === 'dark' ? 'light' : 'dark');
}
</script>

<template>
  <button
    class="theme-toggle"
    type="button"
    aria-label="Toggle theme"
    title="Toggle theme"
    @click="toggle"
  >
    <svg
      class="tt-icon tt-sun"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="4"></circle>
      <path
        d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M6.3 17.7l-1.4 1.4M19.1 4.9l-1.4 1.4"
      ></path>
    </svg>
    <svg
      class="tt-icon tt-moon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"></path>
    </svg>
  </button>
</template>

<style scoped>
.theme-toggle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  border: 1px solid var(--line);
  border-radius: 2px;
  background: var(--surface);
  color: var(--muted);
  cursor: pointer;
  transition:
    color 0.15s,
    border-color 0.15s;
}
.theme-toggle:hover {
  color: var(--green);
  border-color: var(--green);
}
.tt-icon {
  display: none;
  width: 14px;
  height: 14px;
}
.tt-sun {
  display: block;
}
:global([data-theme='light']) .tt-sun {
  display: none;
}
:global([data-theme='light']) .tt-moon {
  display: block;
}
</style>
