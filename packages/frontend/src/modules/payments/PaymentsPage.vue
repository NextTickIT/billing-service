<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { usePaymentsStore } from './store.js';
import type {
  Currency,
  PaymentMethod,
  CreatePaymentRequest,
} from '@billing-service/shared';
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
const PERIOD_OPTIONS = [{ value: 'P4W', label: '4 weeks' }];

const { t } = useI18n();
const router = useRouter();
const store = usePaymentsStore();

const filterUserId = ref('');
const idFilterOpen = ref(false);
const showCreate = ref(false);
const createUserId = ref('');
const createAmount = ref('');
const createCurrency = ref<number>(0);
const createPeriod = ref('P4W');
const createMethod = ref<number>(0);

const filtered = computed(() => {
  const q = filterUserId.value.trim().toLowerCase();
  return q
    ? store.list.filter((p) => p.externalUserId.toLowerCase().includes(q))
    : store.list;
});

onMounted(() => {
  void store.loadList();
});

function clearFilter(): void {
  filterUserId.value = '';
  idFilterOpen.value = false;
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
      <div class="toolbar">
        <span class="toolbar__count">{{ filtered.length }} / {{ store.list.length }}</span>
        <BaseButton :label="t('payments.createButton')" @click="showCreate = true" />
      </div>

      <div v-if="store.loading" class="state-center">
        <BaseSpinner />
      </div>
      <p v-else-if="store.error" class="state-error">{{ store.error }}</p>
      <p v-else-if="store.list.length === 0" class="state-empty">
        {{ t('payments.noResults') }}
      </p>

      <table v-else class="data-table">
        <thead>
          <tr>
            <th class="th-filter">
              <div class="th-filter__row">
                <span>{{ t('payments.externalUserId') }}</span>
                <button
                  type="button"
                  class="filter-icon"
                  :class="{ 'filter-icon--active': filterUserId }"
                  :aria-label="t('payments.externalUserId')"
                  @click="idFilterOpen = !idFilterOpen"
                >
                  <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
                    <path fill="currentColor" d="M0.5 1.5h15l-6 7v5l-3 1.5v-6.5l-6-7z" />
                  </svg>
                </button>
              </div>
              <div v-if="idFilterOpen" class="th-filter__pop">
                <input
                  v-model="filterUserId"
                  class="th-filter__input"
                  type="text"
                  :placeholder="t('payments.externalUserId')"
                />
                <button
                  v-if="filterUserId"
                  type="button"
                  class="filter-clear"
                  @click="clearFilter"
                >
                  ×
                </button>
              </div>
            </th>
            <th>{{ t('common.amount') }}</th>
            <th>{{ t('common.period') }}</th>
            <th>{{ t('payments.periodStart') }} – {{ t('payments.periodEnd') }}</th>
            <th>{{ t('payments.nextPayment') }}</th>
            <th>{{ t('common.status') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="filtered.length === 0" class="data-row--empty">
            <td colspan="6">{{ t('payments.noResults') }} {{ filterUserId }}</td>
          </tr>
          <tr
            v-for="p in filtered"
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

.toolbar {
  display: flex;
  gap: 8px;
  margin-bottom: 16px;
  align-items: center;
}
.toolbar__count {
  flex: 1;
  color: var(--dim);
  font-family: var(--mono);
  font-size: 12px;
}

.th-filter { position: relative; }
.th-filter__row { display: flex; align-items: center; gap: 6px; }
.filter-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 2px;
  border: 0;
  background: transparent;
  color: var(--dim);
  cursor: pointer;
  border-radius: 2px;
}
.filter-icon:hover,
.filter-icon--active { color: var(--green); }
.th-filter__pop {
  position: absolute;
  z-index: 20;
  top: 100%;
  left: 0;
  margin-top: 4px;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px;
  border: 1px solid var(--line);
  background: var(--surface);
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.25);
}
.th-filter__input {
  width: 180px;
  padding: 6px 8px;
  border: 1px solid var(--line);
  background: var(--bg-2);
  color: var(--text);
  font-family: var(--mono);
  font-size: 12px;
}
.th-filter__input:focus { outline: none; border-color: var(--green); }
.filter-clear {
  border: 0;
  background: transparent;
  color: var(--dim);
  cursor: pointer;
  font-size: 16px;
  line-height: 1;
  padding: 0 4px;
}
.filter-clear:hover { color: var(--red); }
.data-row--empty td {
  padding: 16px;
  color: var(--muted);
  font-size: 13px;
  text-align: center;
}

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
