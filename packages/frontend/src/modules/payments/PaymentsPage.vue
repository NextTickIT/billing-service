<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { usePaymentsStore } from './store.js';
import type { CreatePaymentBody } from './api.js';
import BasePanel from '../../components/BasePanel.vue';
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
  { value: 0, label: 'UAH' }, { value: 1, label: 'USD' }, { value: 2, label: 'EUR' },
];
const METHOD_OPTIONS = [{ value: 0, label: 'Card' }];

const { t } = useI18n();
const router = useRouter();
const store = usePaymentsStore();

const filterUserId = ref('');
const searched = ref(false);
const showCreate = ref(false);
const createUserId = ref('');
const createAmount = ref('');
const createCurrency = ref<number>(0);
const createPeriod = ref('P1M');
const createMethod = ref<number>(0);

async function onSearch(): Promise<void> {
  if (!filterUserId.value.trim()) return;
  searched.value = true;
  await store.loadList(filterUserId.value.trim());
}

function toDetail(id: string): void {
  void router.push(`/operator/payments/${id}`);
}

function formatAmount(amount: number, currency: number): string {
  const label = CURRENCY_LABELS[currency] ?? 'UAH';
  const major = (amount / 100).toFixed(2);
  return `${major} ${label}`;
}

function statusCss(s: number): string {
  return STATUS_LABELS[s] ?? '';
}

function buildBody(): CreatePaymentBody {
  return {
    externalUserId: createUserId.value,
    amount: Number(createAmount.value),
    currency: createCurrency.value,
    period: createPeriod.value,
    method: createMethod.value,
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
      <div class="toolbar">
        <BaseInput
          v-model="filterUserId"
          :placeholder="t('payments.filterPlaceholder')"
          class="toolbar__filter"
          @keyup.enter="onSearch"
        />
        <BaseButton :label="t('common.submit')" variant="ghost" @click="onSearch" />
        <BaseButton :label="t('payments.createButton')" @click="showCreate = true" />
      </div>

      <div v-if="store.loading" class="state-center">
        <BaseSpinner />
      </div>
      <p v-else-if="store.error" class="state-error">{{ store.error }}</p>
      <p v-else-if="!searched" class="state-hint">
        {{ t('payments.searchHint') }}
      </p>
      <p v-else-if="store.list.length === 0" class="state-empty">
        {{ t('payments.noResults') }} <span class="state-empty__id">{{ filterUserId }}</span>
      </p>

      <table v-else class="data-table">
        <thead>
          <tr>
            <th>{{ t('payments.externalUserId') }}</th>
            <th>{{ t('common.amount') }}</th>
            <th>{{ t('common.period') }}</th>
            <th>{{ t('payments.periodStart') }} – {{ t('payments.periodEnd') }}</th>
            <th>{{ t('payments.nextPayment') }}</th>
            <th>{{ t('common.status') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="p in store.list"
            :key="p.id"
            class="data-row"
            tabindex="0"
            @click="toDetail(p.id)"
            @keyup.enter="toDetail(p.id)"
          >
            <td class="mono">{{ p.externalUserId }}</td>
            <td class="mono">{{ formatAmount(p.amount, p.currency) }}</td>
            <td>{{ p.period }}</td>
            <td>
              {{ new Date(p.currentPeriodStart).toLocaleDateString() }} –
              {{ new Date(p.currentPeriodEnd).toLocaleDateString() }}
            </td>
            <td>{{ new Date(p.nextPaymentDate).toLocaleDateString() }}</td>
            <td :class="`status--${statusCss(p.status)}`">
              {{ t(`payments.statuses.${p.status}`) }}
            </td>
          </tr>
        </tbody>
      </table>
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
          <BaseInput v-model="createPeriod" placeholder="P1M" />
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

.toolbar {
  display: flex;
  gap: 8px;
  margin-bottom: 16px;
  align-items: center;
}
.toolbar__filter { flex: 1; }

.state-center { text-align: center; padding: 32px 0; }
.state-error { color: var(--red); padding: 8px 0; font-size: 13px; }
.state-hint { color: var(--dim); padding: 8px 0; font-size: 13px; }
.state-empty { color: var(--muted); padding: 8px 0; font-size: 13px; }
.state-empty__id { color: var(--text); font-family: var(--mono); font-size: 12px; }

.data-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.data-table th {
  padding: 8px 12px;
  text-align: left;
  color: var(--muted);
  border-bottom: 1px solid var(--line);
  white-space: nowrap;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
.data-table td { padding: 10px 12px; border-bottom: 1px solid var(--line); color: var(--text); }
.data-row { cursor: pointer; }
.data-row:hover td { background: var(--surface-2); }
.data-row:focus { outline: 2px solid var(--green); outline-offset: -1px; }

.status--active { color: var(--green); }
.status--past_due { color: var(--amber); }
.status--failed,
.status--cancelled { color: var(--red); }

.create-form { display: flex; flex-direction: column; gap: 12px; }
.form-field { display: flex; flex-direction: column; gap: 4px; }
.form-label { color: var(--dim); font-size: 12px; }
.form-error { color: var(--red); font-size: 13px; }
</style>
