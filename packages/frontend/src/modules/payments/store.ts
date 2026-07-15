import { defineStore } from 'pinia';
import { ref } from 'vue';
import {
  listPayments,
  getPayment,
  cancelPayment,
  createPayment,
  type PaymentRecord,
  type CreatePaymentBody,
} from './api.js';

export const usePaymentsStore = defineStore('payments', () => {
  const list = ref<PaymentRecord[]>([]);
  const current = ref<PaymentRecord | null>(null);
  const loading = ref(false);
  const error = ref<string | null>(null);

  async function loadList(externalUserId?: string): Promise<void> {
    loading.value = true;
    error.value = null;
    try {
      list.value = await listPayments(externalUserId);
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Error';
    } finally {
      loading.value = false;
    }
  }

  async function loadDetail(id: string): Promise<void> {
    loading.value = true;
    error.value = null;
    try {
      current.value = await getPayment(id);
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Error';
    } finally {
      loading.value = false;
    }
  }

  async function cancel(id: string, reason: string): Promise<void> {
    loading.value = true;
    error.value = null;
    try {
      await cancelPayment(id, reason);
      if (current.value?.id === id) {
        current.value = { ...current.value, status: 3 };
      }
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Error';
    } finally {
      loading.value = false;
    }
  }

  async function create(body: CreatePaymentBody): Promise<PaymentRecord | null> {
    loading.value = true;
    error.value = null;
    try {
      const created = await createPayment(body);
      list.value = [created, ...list.value];
      return created;
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Error';
      return null;
    } finally {
      loading.value = false;
    }
  }

  return { list, current, loading, error, loadList, loadDetail, cancel, create };
});
