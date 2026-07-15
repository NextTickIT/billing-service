import { defineStore } from 'pinia';
import { ref } from 'vue';
import type {
  Payment,
  PaymentDetail,
  PaymentStatus,
  CreatePaymentRequest,
  CreateAccepted,
} from '@billing-service/shared';

import {
  listPayments,
  getPayment,
  cancelPayment,
  createPayment,
} from './api.js';

const CANCELLED: PaymentStatus = 3;

export const usePaymentsStore = defineStore('payments', () => {
  const list = ref<Payment[]>([]);
  const current = ref<PaymentDetail | null>(null);
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
        current.value = { ...current.value, status: CANCELLED };
      }
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Error';
    } finally {
      loading.value = false;
    }
  }

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

  return { list, current, loading, error, loadList, loadDetail, cancel, create };
});
