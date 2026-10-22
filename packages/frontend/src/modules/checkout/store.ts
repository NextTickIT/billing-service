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
    if (e.status === 404) return 'checkout.errors.notFound';
    if (e.status === 409 || e.status === 410) return 'checkout.errors.unusable';
    if (e.status === 422) return 'checkout.errors.rejected';
    if (e.status === 503) return 'checkout.errors.unavailable';
  }
  return 'checkout.errors.generic';
};

/**
 * A refused pay the buyer can act on without the page giving up on them. `key` is an
 * i18n key, like `error`; `retryable` keeps the Pay button, because a locked method has
 * already been switched in and pressing Pay again is the fix. `perOption` marks a refusal
 * of the picked option only: picking another option clears it (`afterOptionPick`).
 */
interface Notice {
  readonly key: string;
  readonly retryable: boolean;
  readonly perOption?: boolean;
}

/**
 * The refused pays the page recovers from instead of giving up: the notice to show and
 * the session to show it on (switched to the method the server named, when it named
 * one). Null for every other failure, which stays a page-level error.
 */
const recoverableRefusal = (
  e: unknown,
  session: CheckoutSessionPublic | null,
): { notice: Notice; session: CheckoutSessionPublic | null } | null => {
  if (!(e instanceof CheckoutApiError)) return null;
  // The link is locked to one method and the server says which: the subscription's
  // method changed since the link was minted. Switch the page to it and let the buyer
  // confirm with a second press — never auto-submit a method they did not see.
  if (e.code === 'method_locked' && e.method !== null)
    return {
      notice: { key: 'checkout.notices.methodChanged', retryable: true },
      session:
        session === null
          ? null
          : { ...session, method: e.method, methodLocked: true },
    };
  // A 409, but telling a paying customer their link is invalid reads as us being
  // broken. Nothing to retry: they are already covered — unless the page offers other
  // options, since the refusal is about the picked option's terms (an intro offer).
  if (e.code === 'already_subscribed')
    return {
      notice: {
        key: 'checkout.errors.alreadySubscribed',
        retryable: false,
        perOption: (session?.options.length ?? 0) > 1,
      },
      session,
    };
  // The link re-mints at new terms that no longer carry the picked option: the page goes
  // back to the default (CheckoutPage watches for this key) and the buyer presses again.
  if (e.code === 'option_unavailable')
    return {
      notice: {
        key: 'checkout.notices.optionUnavailable',
        retryable: true,
        perOption: true,
      },
      session,
    };
  return null;
};

/** The notice once the buyer picks another option: a refusal of the previous pick no
 * longer applies; a session-wide one does. */
export const afterOptionPick = (notice: Notice | null): Notice | null =>
  notice?.perOption === true ? null : notice;

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
  /** A recoverable refusal, shown above the pay controls rather than replacing them. */
  const notice = ref<Notice | null>(null);

  function fail(e: unknown): void {
    error.value = errorKeyFor(e);
    errorDetail.value = e instanceof CheckoutApiError ? e.serverMessage : null;
  }

  async function load(id: string): Promise<void> {
    loading.value = true;
    error.value = null;
    errorDetail.value = null;
    notice.value = null;
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
    option?: number,
  ): Promise<void> {
    // Re-entry guard: the single source of truth for "a pay is already in flight". The
    // button's `:loading` disables it, but reactivity flushes on the next tick, so a
    // synchronous double-fire (button spam, the verify auto-start racing a click) could
    // still slip a second request through. Bail here so exactly one /pay is ever sent.
    if (submitting.value) return;
    submitting.value = true;
    error.value = null;
    errorDetail.value = null;
    notice.value = null;
    try {
      // On success we leave `submitting` true: the caller immediately hands off (form
      // POST or redirect) to the provider, so the button stays busy through the
      // navigation (no re-enable, no double submit).
      instruction.value = await payApi(id, method, option);
    } catch (e) {
      const refusal = recoverableRefusal(e, session.value);
      if (refusal === null) {
        fail(e);
      } else {
        notice.value = refusal.notice;
        session.value = refusal.session;
      }
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
    notice,
    load,
    pay,
  };
});
