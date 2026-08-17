<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useRoute } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { usePaymentsStore } from './store.js';
import { formatDateTime } from '@/app/datetime.js';
import { useMoney } from '@/app/money.js';
import { PaymentStatus } from '@billing-service/shared';
import BaseSpinner from '@/components/BaseSpinner.vue';
import BaseInput from '@/components/BaseInput.vue';
import BaseButton from '@/components/BaseButton.vue';

const route = useRoute();
const { t, locale } = useI18n();
const { formatAmount } = useMoney();
const store = usePaymentsStore();

const id = route.params['id'] as string;
const cancelReason = ref('');
const deferDays = ref(1);
const deferError = ref<string | null>(null);

onMounted(() => {
  void store.loadDetail(id);
});

const isCancelling = computed((): boolean => {
  const p = store.current;
  return (
    p !== null &&
    p.status === PaymentStatus.Active &&
    p.cancelRequestedAt !== null
  );
});

const isActive = computed(
  (): boolean => store.current?.status === PaymentStatus.Active,
);

function statusLabel(s: number): string {
  return t(`payments.statuses.${s}`);
}

function effectiveStatusLabel(): string {
  if (isCancelling.value) return t('payments.statuses.cancelling');
  return statusLabel(store.current?.status ?? 0);
}

async function handleCancel(): Promise<void> {
  await store.cancel(id, cancelReason.value);
  cancelReason.value = '';
}

async function handleReactivate(): Promise<void> {
  await store.reactivate(id);
}

async function handleDefer(): Promise<void> {
  deferError.value = null;
  if (
    deferDays.value < 1 ||
    deferDays.value > 30 ||
    !Number.isInteger(deferDays.value)
  ) {
    deferError.value = t('payments.deferDaysError');
    return;
  }
  await store.defer(id, deferDays.value);
}
</script>

<template>
  <div class="detail-page">
    <RouterLink to="/operator/payments" class="back-link">
      ← {{ t('common.back') }}
    </RouterLink>

    <div v-if="store.loading" class="detail-center"><BaseSpinner /></div>
    <p v-else-if="store.error" class="detail-error">{{ store.error }}</p>

    <template v-else-if="store.current">
      <div class="info-grid">
        <div class="info-row">
          <span class="lbl">{{ t('payments.externalUserId') }}</span>
          <span>{{ store.current.externalUserId }}</span>
        </div>
        <div class="info-row">
          <span class="lbl">{{ t('common.amount') }}</span>
          <span>{{
            formatAmount(store.current.amount, store.current.currency)
          }}</span>
        </div>
        <div class="info-row">
          <span class="lbl">{{ t('common.period') }}</span>
          <span>{{ store.current.period }}</span>
        </div>
        <div class="info-row">
          <span class="lbl">{{ t('common.status') }}</span>
          <span>{{ effectiveStatusLabel() }}</span>
        </div>
        <div class="info-row">
          <span class="lbl">{{ t('payments.periodStart') }}</span>
          <span>{{
            formatDateTime(store.current.currentPeriodStart, locale)
          }}</span>
        </div>
        <div class="info-row">
          <span class="lbl">{{ t('payments.periodEnd') }}</span>
          <span>{{
            formatDateTime(store.current.currentPeriodEnd, locale)
          }}</span>
        </div>
        <div class="info-row">
          <span class="lbl">{{ t('payments.nextPayment') }}</span>
          <span>{{
            formatDateTime(store.current.nextPaymentDate, locale)
          }}</span>
        </div>
      </div>

      <!-- Cancelling notice -->
      <div v-if="isCancelling" class="notice notice--cancelling">
        {{
          t('payments.cancellingNotice', {
            date: formatDateTime(store.current.currentPeriodEnd, locale),
          })
        }}
      </div>

      <!-- Reactivate (only while in cancelling state) -->
      <div v-if="isCancelling" class="action-section">
        <h2 class="section-title">{{ t('payments.reactivateTitle') }}</h2>
        <BaseButton
          :label="t('payments.reactivateButton')"
          :loading="store.loading"
          @click="handleReactivate"
        />
      </div>

      <!-- Defer (only while active, cancelling counts as active status) -->
      <div v-if="isActive" class="action-section">
        <h2 class="section-title">{{ t('payments.deferTitle') }}</h2>
        <div class="defer-row">
          <input
            v-model.number="deferDays"
            class="defer-input"
            type="number"
            min="1"
            max="30"
            :aria-label="t('payments.deferDaysLabel')"
          />
          <span class="defer-unit">{{ t('payments.deferDaysLabel') }}</span>
          <BaseButton
            :label="t('payments.deferButton')"
            :loading="store.loading"
            @click="handleDefer"
          />
        </div>
        <p v-if="deferError" class="action-error">{{ deferError }}</p>
      </div>

      <h2 class="section-title">{{ t('payments.charges') }}</h2>
      <table class="charges-table">
        <thead>
          <tr>
            <th>{{ t('payments.chargeDate') }}</th>
            <th>{{ t('payments.chargeAmount') }}</th>
            <th>Source</th>
            <th>Result</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-if="!store.current.charges || store.current.charges.length === 0"
          >
            <td colspan="4" class="charges-empty">
              {{ t('payments.noResults') }}
            </td>
          </tr>
          <tr v-for="c in store.current.charges" :key="c.id">
            <td>{{ formatDateTime(c.occurredAt, locale) }}</td>
            <td>{{ formatAmount(c.amount, c.currency) }}</td>
            <td class="mono">{{ c.source }}</td>
            <td class="result-ok">succeeded</td>
          </tr>
        </tbody>
      </table>

      <div class="cancel-section">
        <h2 class="section-title">{{ t('payments.cancelTitle') }}</h2>
        <div class="cancel-row">
          <BaseInput
            v-model="cancelReason"
            :placeholder="t('payments.cancelReason')"
          />
          <BaseButton
            :label="t('payments.cancelButton')"
            variant="danger"
            :loading="store.loading"
            @click="handleCancel"
          />
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.detail-page {
  padding: 20px;
  max-width: 800px;
}
.back-link {
  display: inline-block;
  margin-bottom: 16px;
  color: var(--muted);
}
.back-link:hover {
  color: var(--text);
}
.detail-center {
  text-align: center;
  padding: 20px 0;
}
.detail-error {
  color: var(--red);
}
.info-grid {
  margin-bottom: 20px;
}
.info-row {
  display: flex;
  justify-content: space-between;
  padding: 8px 0;
  border-bottom: 1px solid var(--line);
}
.lbl {
  color: var(--muted);
}
.section-title {
  font-size: 11px;
  color: var(--muted);
  margin: 20px 0 8px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  font-family: var(--mono);
}
.notice {
  padding: 10px 14px;
  border-radius: 6px;
  font-size: 13px;
  margin-bottom: 16px;
}
.notice--cancelling {
  background: color-mix(in srgb, var(--amber) 12%, transparent);
  border: 1px solid var(--amber);
  color: var(--amber);
}
.action-section {
  padding: 16px;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: 6px;
  margin-bottom: 16px;
}
.defer-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
}
.defer-input {
  width: 64px;
  padding: 6px 8px;
  border: 1px solid var(--line);
  border-radius: 4px;
  background: var(--bg);
  color: var(--text);
  font-size: 13px;
  font-family: var(--mono);
}
.defer-unit {
  color: var(--muted);
  font-size: 13px;
}
.action-error {
  color: var(--red);
  font-size: 13px;
  margin-top: 8px;
}
.charges-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
  margin-bottom: 20px;
}
.charges-table th {
  text-align: left;
  padding: 8px 12px;
  border-bottom: 1px solid var(--line);
  color: var(--muted);
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
.charges-table td {
  padding: 8px 12px;
  border-bottom: 1px solid var(--line);
}
.cancel-section {
  padding: 16px;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: 6px;
}
.cancel-row {
  display: flex;
  gap: 8px;
  margin-top: 10px;
}
</style>
