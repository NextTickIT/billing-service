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
  // `submitting` is distinct from `loading` on purpose: the pay click must NOT flip
  // the page-level `loading` (that swaps the whole panel for a spinner and visibly
  // redraws the page just before we redirect to the provider). It drives only the
  // button's own spinner while we fetch the form and hand off to WayForPay.
  const submitting = ref(false);
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
    submitting.value = true;
    error.value = null;
    try {
      // On success we leave `submitting` true: the caller immediately submits the
      // returned form and navigates to WayForPay, so the button stays busy through
      // the redirect (no re-enable, no double submit).
      form.value = await payByCard(id);
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Error';
      submitting.value = false;
    }
  }

  return { session, loading, submitting, error, form, load, pay };
});
