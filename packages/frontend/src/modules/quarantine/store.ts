import { defineStore } from 'pinia';
import { ref } from 'vue';
import { listQuarantine, bindQuarantine } from './api.js';
import type { QuarantineView } from './api.js';

export const useQuarantineStore = defineStore('quarantine', () => {
  const items = ref<QuarantineView[]>([]);
  const loading = ref(false);
  const error = ref<string | null>(null);

  async function load(): Promise<void> {
    loading.value = true;
    error.value = null;
    try {
      items.value = await listQuarantine();
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Error';
    } finally {
      loading.value = false;
    }
  }

  async function bind(id: string, paymentId: string): Promise<void> {
    loading.value = true;
    error.value = null;
    try {
      await bindQuarantine(id, paymentId);
      items.value = items.value.filter((i) => i.quarantineId !== id);
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Error';
    } finally {
      loading.value = false;
    }
  }

  return { items, loading, error, load, bind };
});
