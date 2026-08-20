import { defineStore } from 'pinia';
import { ref } from 'vue';
import { PaymentMethod } from '@billing-service/shared';
import {
  getCheckoutSession,
  pay as payApi,
  type CheckoutSessionPublic,
  type PayInstruction,
} from './api.js';

export const useCheckoutStore = defineStore('checkout', () => {
  const session = ref<CheckoutSessionPublic | null>(null);
  const loading = ref(false);
  // `submitting` is distinct from `loading` on purpose: the pay click must NOT flip
  // the page-level `loading` (that swaps the whole panel for a spinner and visibly
  // redraws the page just before we redirect to the provider). It drives only the
  // button's own spinner while we fetch the handoff and navigate to the provider.
  const submitting = ref(false);
  const error = ref<string | null>(null);
  const instruction = ref<PayInstruction | null>(null);

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

  async function pay(
    id: string,
    method: PaymentMethod = PaymentMethod.Card,
  ): Promise<void> {
    submitting.value = true;
    error.value = null;
    try {
      // On success we leave `submitting` true: the caller immediately hands off (form
      // POST or redirect) to the provider, so the button stays busy through the
      // navigation (no re-enable, no double submit).
      instruction.value = await payApi(id, method);
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Error';
      submitting.value = false;
    }
  }

  return { session, loading, submitting, error, instruction, load, pay };
});
