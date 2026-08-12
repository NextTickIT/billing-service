import { defineStore } from 'pinia';
import { ref } from 'vue';
import type {
  Payment,
  PaymentDetail,
  CreatePaymentRequest,
  CreateAccepted,
} from '@billing-service/shared';

import {
  listPayments,
  getPayment,
  cancelPayment,
  createPayment,
  reactivatePayment,
  deferPayment,
} from './api.js';
import type { ListPaymentsFilter } from './api.js';

// Shared state refs — declared outside so helpers can close over them without
// being defined inside the setup function (which would exceed max-lines-per-function).
interface StoreRefs {
  list: ReturnType<typeof ref<Payment[]>>;
  current: ReturnType<typeof ref<PaymentDetail | null>>;
  loading: ReturnType<typeof ref<boolean>>;
  error: ReturnType<typeof ref<string | null>>;
  filter: ReturnType<typeof ref<ListPaymentsFilter>>;
}

function wrapAction<A extends unknown[]>(
  refs: StoreRefs,
  fn: (...args: A) => Promise<void>,
): (...args: A) => Promise<void> {
  return async (...args: A): Promise<void> => {
    refs.loading.value = true;
    refs.error.value = null;
    try {
      await fn(...args);
    } catch (e) {
      refs.error.value = e instanceof Error ? e.message : 'Error';
    } finally {
      refs.loading.value = false;
    }
  };
}

export const usePaymentsStore = defineStore('payments', () => {
  const list = ref<Payment[]>([]);
  const current = ref<PaymentDetail | null>(null);
  const loading = ref(false);
  const error = ref<string | null>(null);
  const filter = ref<ListPaymentsFilter>({});

  const refs: StoreRefs = { list, current, loading, error, filter };

  const loadDetail = wrapAction(refs, async (id: string) => {
    current.value = await getPayment(id);
  });

  const loadList = wrapAction(refs, async (f?: ListPaymentsFilter) => {
    if (f !== undefined) filter.value = f;
    list.value = await listPayments(filter.value);
  });

  const cancel = wrapAction(refs, async (id: string, reason: string) => {
    await cancelPayment(id, reason);
    await loadDetail(id);
  });

  const reactivate = wrapAction(refs, async (id: string) => {
    await reactivatePayment(id);
    await loadDetail(id);
  });

  const defer = wrapAction(refs, async (id: string, days: number) => {
    await deferPayment(id, days);
    await loadDetail(id);
  });

  async function create(
    body: CreatePaymentRequest,
  ): Promise<CreateAccepted | null> {
    loading.value = true;
    error.value = null;
    try {
      const created = await createPayment(body);
      await loadList();
      return created;
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Error';
      return null;
    } finally {
      loading.value = false;
    }
  }

  return {
    list,
    current,
    loading,
    error,
    filter,
    loadList,
    loadDetail,
    cancel,
    reactivate,
    defer,
    create,
  };
});
