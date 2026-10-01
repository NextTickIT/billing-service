import { defineStore } from 'pinia';
import { ref } from 'vue';
import { PaymentMethod } from '@billing-service/shared';
import {
  CheckoutApiError,
  getCheckoutSession,
  pay as payApi,
  type CheckoutSessionPublic,
  type PayInstruction,
} from './api.js';

/**
 * Map a failed call to an i18n key. The page renders `t(error)`, so nothing internal
 * ever reaches the buyer. 409/410 are collapsed deliberately: the backend distinguishes
 * "expired", "completed" and "already in progress", but all three mean the same thing
 * to whoever is holding the link — this one cannot be used, ask for a new one.
 */
const errorKeyFor = (e: unknown): string => {
  if (e instanceof CheckoutApiError) {
    // Checked before the status: this is a 409, but telling a paying customer their
    // link is invalid reads as us being broken.
    if (e.code === 'already_subscribed')
      return 'checkout.errors.alreadySubscribed';
    if (e.status === 404) return 'checkout.errors.notFound';
    if (e.status === 409 || e.status === 410) return 'checkout.errors.unusable';
    if (e.status === 422) return 'checkout.errors.rejected';
    if (e.status === 503) return 'checkout.errors.unavailable';
  }
  return 'checkout.errors.generic';
};

export const useCheckoutStore = defineStore('checkout', () => {
  const session = ref<CheckoutSessionPublic | null>(null);
  const loading = ref(false);
  // `submitting` is distinct from `loading` on purpose: the pay click must NOT flip
  // the page-level `loading` (that swaps the whole panel for a spinner and visibly
  // redraws the page just before we redirect to the provider). It drives only the
  // button's own spinner while we fetch the handoff and navigate to the provider.
  const submitting = ref(false);
  /** An i18n key, never raw text — the page renders it through `t()`. */
  const error = ref<string | null>(null);
  /** Provider-written detail worth showing verbatim (422 only); otherwise null. */
  const errorDetail = ref<string | null>(null);
  const instruction = ref<PayInstruction | null>(null);

  function fail(e: unknown): void {
    error.value = errorKeyFor(e);
    errorDetail.value = e instanceof CheckoutApiError ? e.serverMessage : null;
  }

  async function load(id: string): Promise<void> {
    loading.value = true;
    error.value = null;
    errorDetail.value = null;
    try {
      session.value = await getCheckoutSession(id);
    } catch (e) {
      fail(e);
    } finally {
      loading.value = false;
    }
  }

  async function pay(
    id: string,
    method: PaymentMethod = PaymentMethod.Card,
  ): Promise<void> {
    // Re-entry guard: the single source of truth for "a pay is already in flight". The
    // button's `:loading` disables it, but reactivity flushes on the next tick, so a
    // synchronous double-fire (button spam, the verify auto-start racing a click) could
    // still slip a second request through. Bail here so exactly one /pay is ever sent.
    if (submitting.value) return;
    submitting.value = true;
    error.value = null;
    errorDetail.value = null;
    try {
      // On success we leave `submitting` true: the caller immediately hands off (form
      // POST or redirect) to the provider, so the button stays busy through the
      // navigation (no re-enable, no double submit).
      instruction.value = await payApi(id, method);
    } catch (e) {
      fail(e);
      submitting.value = false;
    }
  }

  return {
    session,
    loading,
    submitting,
    error,
    errorDetail,
    instruction,
    load,
    pay,
  };
});
