<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { usePaymentsStore } from './store.js';
import { formatDate } from '../../app/datetime.js';
import type {
  Currency,
  PaymentMethod,
  CreatePaymentRequest,
  Payment,
} from '@billing-service/shared';
import BasePanel from '../../components/BasePanel.vue';
import DataTable from '../../components/DataTable.vue';
import BaseInput from '../../components/BaseInput.vue';
import BaseButton from '../../components/BaseButton.vue';
import BaseSpinner from '../../components/BaseSpinner.vue';
import BaseModal from '../../components/BaseModal.vue';
import BaseSelect from '../../components/BaseSelect.vue';

const CURRENCY_LABELS: Record<number, string> = { 0: 'UAH', 1: 'USD', 2: 'EUR' };
const STATUS_LABELS: Record<number, string> = {
  0: 'active', 1: 'past_due', 2: 'failed', 3: 'cancelled',
};
const CURRENCY_OPTIONS = [
  { value: 0, label: 'UAH' }, { value: 1, label: 'USD' },
];
const METHOD_OPTIONS = [{ value: 0, label: 'Card' }];
const PERIOD_OPTIONS = [{ value: 'P4W', label: '4 weeks' }];

const { t, locale } = useI18n();
const router = useRouter();
const store = usePaymentsStore();

const showCreate = ref(false);
const createUserId = ref('');
const createAmount = ref('');
const createCurrency = ref<number>(0);
const createPeriod = ref('P4W');
const createMethod = ref<number>(0);

onMounted(() => {
  void store.loadList();
});

function matchUser(p: Payment, q: string): boolean {
  return p.externalUserId.toLowerCase().includes(q);
}
function rowKey(p: Payment): string {
  return p.id;
}
function onRowClick(p: Payment): void {
  void router.push(`/operator/payments/${p.id}`);
}

function formatAmount(amount: number, currency: number): string {
  const label = CURRENCY_LABELS[currency] ?? 'UAH';
  return `${(amount / 100).toFixed(2)} ${label}`;
}

function statusCss(s: number): string {
  return STATUS_LABELS[s] ?? '';
}

function buildBody(): CreatePaymentRequest {
  return {
    externalUserId: createUserId.value,
    amount: Number(createAmount.value),
    currency: createCurrency.value as Currency,
    period: createPeriod.value,
    method: createMethod.value as PaymentMethod,
  };
}

async function onCreate(): Promise<void> {
  const result = await store.create(buildBody());
  if (result) {
    showCreate.value = false;
    createUserId.value = '';
    createAmount.value = '';
  }
}
</script>

<template>
  <div class="payments-page">
    <BasePanel :title="t('payments.title')">
      <template #actions>
        <button
          type="button"
          class="add-btn"
          :title="t('payments.createButton')"
          :aria-label="t('payments.createButton')"
          @click="showCreate = true"
        >
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <path
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              d="M8 3v10M3 8h10"
            />
          </svg>
        </button>
      </template>

      <div v-if="store.loading" class="state-center">
        <BaseSpinner />
      </div>
      <p v-else-if="store.error" class="state-error">{{ store.error }}</p>

      <DataTable
        v-else
        :items="store.list"
        :filter-label="t('payments.externalUserId')"
        :filter-match="matchUser"
        :row-key="rowKey"
        :colspan="6"
        :empty-text="t('payments.noResults')"
        clickable
        @row-click="onRowClick"
      >
        <template #head>
          <th>{{ t('common.amount') }}</th>
          <th>{{ t('common.period') }}</th>
          <th>{{ t('payments.periodStart') }} – {{ t('payments.periodEnd') }}</th>
          <th>{{ t('payments.nextPayment') }}</th>
          <th>{{ t('common.status') }}</th>
        </template>
        <template #row="{ item }">
          <td class="mono">{{ item.externalUserId }}</td>
          <td class="mono">{{ formatAmount(item.amount, item.currency) }}</td>
          <td>{{ item.period }}</td>
          <td>
            {{ formatDate(item.currentPeriodStart, locale) }} –
            {{ formatDate(item.currentPeriodEnd, locale) }}
          </td>
          <td>{{ formatDate(item.nextPaymentDate, locale) }}</td>
          <td :class="`status--${statusCss(item.status)}`">
            {{ t(`payments.statuses.${item.status}`) }}
          </td>
        </template>
      </DataTable>
    </BasePanel>

    <BaseModal
      :open="showCreate"
      :title="t('payments.createTitle')"
      @close="showCreate = false"
    >
      <form class="create-form" @submit.prevent="onCreate">
        <div class="form-field">
          <label class="form-label">{{ t('payments.externalUserId') }}</label>
          <BaseInput v-model="createUserId" placeholder="user_123" />
        </div>
        <div class="form-field">
          <label class="form-label">{{ t('common.amount') }}</label>
          <BaseInput v-model="createAmount" placeholder="100000" />
        </div>
        <div class="form-field">
          <label class="form-label">{{ t('common.currency') }}</label>
          <BaseSelect v-model="createCurrency" :options="CURRENCY_OPTIONS" />
        </div>
        <div class="form-field">
          <label class="form-label">{{ t('common.period') }}</label>
          <BaseSelect v-model="createPeriod" :options="PERIOD_OPTIONS" />
        </div>
        <div class="form-field">
          <label class="form-label">{{ t('common.method') }}</label>
          <BaseSelect v-model="createMethod" :options="METHOD_OPTIONS" />
        </div>
        <p v-if="store.error" class="form-error">{{ store.error }}</p>
        <BaseButton
          :label="t('payments.createButton')"
          :loading="store.loading"
          @click="onCreate"
        />
      </form>
    </BaseModal>
  </div>
</template>

<style scoped>
.payments-page { display: flex; flex-direction: column; gap: 0; }

.add-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  border: 1px solid var(--line);
  border-radius: 2px;
  background: var(--surface);
  color: var(--muted);
  cursor: pointer;
  transition: color 0.15s, border-color 0.15s;
}
.add-btn:hover { color: var(--green); border-color: var(--green); }

.state-center { text-align: center; padding: 32px 0; }
.state-error { color: var(--red); padding: 8px 0; font-size: 13px; }

.status--active { color: var(--green); }
.status--past_due { color: var(--amber); }
.status--failed,
.status--cancelled { color: var(--red); }

.create-form { display: flex; flex-direction: column; gap: 12px; }
.form-field { display: flex; flex-direction: column; gap: 4px; }
.form-label { color: var(--dim); font-size: 12px; }
.form-error { color: var(--red); font-size: 13px; }
</style>
