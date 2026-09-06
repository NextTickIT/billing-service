<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { usePaymentsStore } from './store.js';
import { formatDate } from '@/app/datetime.js';
import { useMoney } from '@/app/money.js';
import { usePaymentOptions } from '@/app/options.js';
import {
  Currency,
  PaymentMethod,
  PaymentStatus,
  type CreatePaymentRequest,
  type Payment,
} from '@billing-service/shared';
import BasePanel from '@/components/BasePanel.vue';
import DataTable from '@/components/DataTable.vue';
import BaseInput from '@/components/BaseInput.vue';
import BaseButton from '@/components/BaseButton.vue';
import BaseSpinner from '@/components/BaseSpinner.vue';
import BaseModal from '@/components/BaseModal.vue';
import BaseSelect from '@/components/BaseSelect.vue';

const { t, locale } = useI18n();
const { formatAmount } = useMoney();
const { currencyOptions, methodOptions, periodOptions } = usePaymentOptions();
const router = useRouter();
const store = usePaymentsStore();

const showCreate = ref(false);
const createUserId = ref('');
const createAmount = ref('');
const createCurrency = ref<number>(Currency.UAH);
const createPeriod = ref('P4W');
const createMethod = ref<number>(PaymentMethod.Card);

// Status filter state — null means "show all"
const activeChip = ref<'cancelling' | PaymentStatus | null>(null);

function chipClass(chip: 'cancelling' | PaymentStatus): string {
  return activeChip.value === chip ? 'chip chip--active' : 'chip';
}

function toggleChip(chip: 'cancelling' | PaymentStatus): void {
  activeChip.value = activeChip.value === chip ? null : chip;
  applyFilter();
}

function applyFilter(): void {
  const chip = activeChip.value;
  const uid = store.filter.externalUserId;
  const base = uid !== undefined ? { externalUserId: uid } : {};
  if (chip === null) {
    void store.loadList(base);
  } else if (chip === 'cancelling') {
    void store.loadList({ ...base, cancelling: true });
  } else {
    void store.loadList({ ...base, statuses: [chip] });
  }
}

onMounted(() => {
  void store.loadList();
});

function isCancelling(p: Payment): boolean {
  return p.status === PaymentStatus.Active && p.cancelRequestedAt !== null;
}

function statusLabel(p: Payment): string {
  if (isCancelling(p)) return t('payments.statuses.cancelling');
  return t(`payments.statuses.${p.status}`);
}

// Recurring (subscription) vs one-time purchase — the value comes from the shared
// `recurring` flag; the label is localised (never a JS map redefined per component).
function typeLabel(p: Payment): string {
  return p.recurring ? t('payments.recurring') : t('payments.oneTime');
}

function matchUser(p: Payment, q: string): boolean {
  return p.externalUserId.toLowerCase().includes(q);
}
function rowKey(p: Payment): string {
  return p.id;
}
function onRowClick(p: Payment): void {
  void router.push(`/operator/payments/${p.id}`);
}

function statusClass(p: Payment): string {
  if (isCancelling(p)) return 'status--Cancelling';
  return `status--${PaymentStatus[p.status]}`;
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

      <div class="filter-bar">
        <button
          v-for="chip in [
            PaymentStatus.Active,
            'cancelling',
            PaymentStatus.PastDue,
            PaymentStatus.Cancelled,
            PaymentStatus.RenewalFailed,
          ] as const"
          :key="String(chip)"
          type="button"
          :class="chipClass(chip)"
          @click="toggleChip(chip)"
        >
          {{
            chip === 'cancelling'
              ? t('payments.statuses.cancelling')
              : t(`payments.statuses.${chip}`)
          }}
        </button>
      </div>

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
        :colspan="7"
        :empty-text="t('payments.noResults')"
        clickable
        @row-click="onRowClick"
      >
        <template #head>
          <th>{{ t('payments.type') }}</th>
          <th>{{ t('common.amount') }}</th>
          <th>{{ t('common.period') }}</th>
          <th>
            {{ t('payments.periodStart') }} – {{ t('payments.periodEnd') }}
          </th>
          <th>{{ t('payments.nextPayment') }}</th>
          <th>{{ t('common.status') }}</th>
        </template>
        <template #row="{ item }">
          <td class="mono">{{ item.externalUserId }}</td>
          <td>
            <span
              class="type-badge"
              :class="
                item.recurring ? 'type-badge--recurring' : 'type-badge--oneTime'
              "
            >
              {{ typeLabel(item) }}
            </span>
          </td>
          <td class="mono">{{ formatAmount(item.amount, item.currency) }}</td>
          <td>{{ item.period }}</td>
          <td>
            {{ formatDate(item.currentPeriodStart, locale) }} –
            {{ formatDate(item.currentPeriodEnd, locale) }}
          </td>
          <td>{{ formatDate(item.nextPaymentDate, locale) }}</td>
          <td :class="statusClass(item)">
            {{ statusLabel(item) }}
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
          <BaseSelect v-model="createCurrency" :options="currencyOptions" />
        </div>
        <div class="form-field">
          <label class="form-label">{{ t('common.period') }}</label>
          <BaseSelect v-model="createPeriod" :options="periodOptions" />
        </div>
        <div class="form-field">
          <label class="form-label">{{ t('common.method') }}</label>
          <BaseSelect v-model="createMethod" :options="methodOptions" />
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
.payments-page {
  display: flex;
  flex-direction: column;
  gap: 0;
}

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
  transition:
    color 0.15s,
    border-color 0.15s;
}
.add-btn:hover {
  color: var(--green);
  border-color: var(--green);
}

.filter-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 8px 0 12px;
}

.chip {
  padding: 3px 10px;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: var(--surface);
  color: var(--muted);
  font-size: 12px;
  cursor: pointer;
  transition:
    color 0.15s,
    border-color 0.15s,
    background 0.15s;
}
.chip:hover {
  color: var(--text);
  border-color: var(--line-2);
}
.chip--active {
  background: var(--green);
  border-color: var(--green);
  color: var(--bg);
  font-weight: 600;
}

.state-center {
  text-align: center;
  padding: 32px 0;
}
.state-error {
  color: var(--red);
  padding: 8px 0;
  font-size: 13px;
}

.status--Active {
  color: var(--green);
}
.status--Cancelling {
  color: var(--amber);
}
.status--PastDue {
  color: var(--amber);
}
.status--RenewalFailed,
.status--Cancelled {
  color: var(--red);
}

.type-badge {
  display: inline-block;
  padding: 1px 8px;
  border: 1px solid var(--line);
  border-radius: 10px;
  font-size: 11px;
  white-space: nowrap;
}
.type-badge--recurring {
  color: var(--green);
  border-color: color-mix(in srgb, var(--green) 40%, var(--line));
}
.type-badge--oneTime {
  color: var(--muted);
}

.create-form {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.form-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.form-label {
  color: var(--dim);
  font-size: 12px;
}
.form-error {
  color: var(--red);
  font-size: 13px;
}
</style>
