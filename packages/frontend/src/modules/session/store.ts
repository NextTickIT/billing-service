import { defineStore } from 'pinia';
import { ref } from 'vue';
import { login as apiLogin } from './api.js';

export const useSessionStore = defineStore('session', () => {
  const loading = ref(false);
  const error = ref<string | null>(null);

  async function login(username: string, password: string): Promise<boolean> {
    loading.value = true;
    error.value = null;
    try {
      await apiLogin(username, password);
      return true;
    } catch {
      error.value = 'invalid';
      return false;
    } finally {
      loading.value = false;
    }
  }

  return { loading, error, login };
});
