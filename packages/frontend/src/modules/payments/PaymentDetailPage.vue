<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useRoute } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { usePaymentsStore } from './store.js';
import BaseSpinner from '../../components/BaseSpinner.vue';
import BaseInput from '../../components/BaseInput.vue';
import BaseButton from '../../components/BaseButton.vue';

const CURRENCY_LABELS: Record<number, string> = { 0: 'UAH', 1: 'USD', 2: 'EUR' };

const route = useRoute();
const { t } = useI18n();
const store = usePaymentsStore();

const id = route.params['id'] as string;
const cancelReason = ref('');

onMounted(() => { void store.loadDetail(id); });

function currencyLabel(c: number): string {
  return CURRENCY_LABELS[c] ?? 'UAH';
}

function statusLabel(s: number): string {
  return t(`payments.statuses.${s}`);
}

async function handleCancel(): Promise<void> {
  await store.cancel(id, cancelReason.value);
  cancelReason.value = '';
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
          <span>{{ store.current.amount }} {{ currencyLabel(store.current.currency) }}</span>
        </div>
        <div class="info-row">
          <span class="lbl">{{ t('common.period') }}</span>
          <span>{{ store.current.period }}</span>
        </div>
        <div class="info-row">
          <span class="lbl">{{ t('common.status') }}</span>
          <span>{{ statusLabel(store.current.status) }}</span>
        </div>
        <div class="info-row">
          <span class="lbl">{{ t('payments.periodStart') }}</span>
          <span>{{ store.current.currentPeriodStart }}</span>
        </div>
        <div class="info-row">
          <span class="lbl">{{ t('payments.periodEnd') }}</span>
          <span>{{ store.current.currentPeriodEnd }}</span>
        </div>
        <div class="info-row">
          <span class="lbl">{{ t('payments.nextPayment') }}</span>
          <span>{{ store.current.nextPaymentDate }}</span>
        </div>
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
          <tr v-if="!store.current.charges || store.current.charges.length === 0">
            <td colspan="4" class="charges-empty">{{ t('payments.noResults') }}</td>
          </tr>
          <tr v-for="c in store.current.charges" :key="c.id">
            <td>{{ new Date(c.occurredAt).toLocaleString() }}</td>
            <td>{{ (c.amount / 100).toFixed(2) }} {{ currencyLabel(c.currency) }}</td>
            <td class="mono">{{ c.source }}</td>
            <td class="result-ok">succeeded</td>
          </tr>
        </tbody>
      </table>

      <div class="cancel-section">
        <h2 class="section-title">{{ t('payments.cancelTitle') }}</h2>
        <div class="cancel-row">
          <BaseInput v-model="cancelReason" :placeholder="t('payments.cancelReason')" />
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
.detail-page { padding: 20px; max-width: 800px; }
.back-link { display: inline-block; margin-bottom: 16px; color: var(--muted); }
.back-link:hover { color: var(--text); }
.detail-center { text-align: center; padding: 20px 0; }
.detail-error { color: var(--red); }
.info-grid { margin-bottom: 20px; }
.info-row {
  display: flex; justify-content: space-between;
  padding: 8px 0; border-bottom: 1px solid var(--line);
}
.lbl { color: var(--muted); }
.section-title { font-size: 11px; color: var(--muted); margin: 20px 0 8px; text-transform: uppercase; letter-spacing: 0.06em; font-family: var(--mono); }
.charges-table { width: 100%; border-collapse: collapse; font-size: 13px; margin-bottom: 20px; }
.charges-table th {
  text-align: left; padding: 8px 12px;
  border-bottom: 1px solid var(--line); color: var(--muted); font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em;
}
.charges-table td { padding: 8px 12px; border-bottom: 1px solid var(--line); }
.cancel-section { padding: 16px; background: var(--surface); border: 1px solid var(--line); border-radius: 6px; }
.cancel-row { display: flex; gap: 8px; margin-top: 10px; }
</style>
