import { defineStore } from 'pinia';
import { ref } from 'vue';
import { login as apiLogin, logout as apiLogout } from './api.js';

const AUTH_KEY = 'operator_authed';

export function isAuthed(): boolean {
  return localStorage.getItem(AUTH_KEY) === '1';
}

export const useSessionStore = defineStore('session', () => {
  const loading = ref(false);
  const error = ref<string | null>(null);

  async function login(username: string, password: string): Promise<boolean> {
    loading.value = true;
    error.value = null;
    try {
      await apiLogin(username, password);
      localStorage.setItem(AUTH_KEY, '1');
      return true;
    } catch {
      error.value = 'invalid';
      return false;
    } finally {
      loading.value = false;
    }
  }

  async function logout(): Promise<void> {
    localStorage.removeItem(AUTH_KEY);
    await apiLogout();
  }

  return { loading, error, login, logout };
});
