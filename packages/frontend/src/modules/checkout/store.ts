import { defineStore } from 'pinia';
import { ref } from 'vue';
import {
  getCheckoutSession,
  payByCard,
  type CheckoutSessionPublic,
  type PurchaseForm,
} from './api.js';

export const useCheckoutStore = defineStore('checkout', () => {
  const session = ref<CheckoutSessionPublic | null>(null);
  const loading = ref(false);
  const error = ref<string | null>(null);
  const form = ref<PurchaseForm | null>(null);

  async function load(id: string): Promise<void> {
    loading.value = true;
    error.value = null;
    try {
      session.value = await getCheckoutSession(id);
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Error';
    } finally {
      loading.value = false;
    }
  }

  async function pay(id: string): Promise<void> {
    loading.value = true;
    error.value = null;
    try {
      form.value = await payByCard(id);
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Error';
    } finally {
      loading.value = false;
    }
  }

  return { session, loading, error, form, load, pay };
});
