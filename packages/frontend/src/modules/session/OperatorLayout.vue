<script setup lang="ts">
import { useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { useSessionStore } from './store.js';
import ThemeToggle from '../../components/ThemeToggle.vue';
import LangSwitch from '../../components/LangSwitch.vue';

const { t } = useI18n();
const router = useRouter();
const store = useSessionStore();

async function onLogout(): Promise<void> {
  await store.logout();
  await router.push('/operator/login');
}
</script>

<template>
  <div class="op-layout">
    <header class="op-nav">
      <nav class="op-nav__links" aria-label="Operator navigation">
        <RouterLink to="/operator/payments" class="op-nav__link">
          {{ t('payments.title') }}
        </RouterLink>
        <RouterLink to="/operator/quarantine" class="op-nav__link">
          {{ t('quarantine.title') }}
        </RouterLink>
      </nav>
      <div class="op-nav__actions">
        <ThemeToggle />
        <LangSwitch />
        <button class="op-nav__logout" type="button" @click="onLogout">
          {{ t('session.logout') }}
        </button>
      </div>
    </header>
    <main class="op-main">
      <RouterView />
    </main>
  </div>
</template>

<style scoped>
.op-layout {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  background: var(--bg);
}

.op-nav {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 20px;
  height: 48px;
  background: var(--surface);
  border-bottom: 1px solid var(--line);
  position: sticky;
  top: 0;
  z-index: 100;
}

.op-nav__links {
  display: flex;
  gap: 4px;
  height: 100%;
  align-items: center;
}

.op-nav__link {
  display: inline-flex;
  align-items: center;
  height: 100%;
  padding: 0 12px;
  color: var(--muted);
  font-size: 13px;
  font-weight: 500;
  text-decoration: none;
  border-bottom: 2px solid transparent;
  transition: color 0.15s, border-color 0.15s;
}

.op-nav__link:hover {
  color: var(--text);
  text-decoration: none;
}

.op-nav__link.router-link-active {
  color: var(--text);
  border-bottom-color: var(--green);
}

.op-nav__actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.op-nav__logout {
  display: inline-flex;
  align-items: center;
  padding: 5px 10px;
  background: transparent;
  border: 1px solid var(--line);
  border-radius: 4px;
  color: var(--dim);
  font-family: var(--sans);
  font-size: 12px;
  cursor: pointer;
  transition: color 0.15s, border-color 0.15s;
}

.op-nav__logout:hover {
  color: var(--red);
  border-color: var(--red);
}

.op-main {
  flex: 1;
  padding: 20px;
  max-width: var(--max);
  width: 100%;
  margin: 0 auto;
  box-sizing: border-box;
}
</style>
