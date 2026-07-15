<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { useQuarantineStore } from './store.js';
import type { QuarantineView } from './api.js';
import BasePanel from '../../components/BasePanel.vue';
import BaseSpinner from '../../components/BaseSpinner.vue';
import BaseButton from '../../components/BaseButton.vue';
import BaseInput from '../../components/BaseInput.vue';
import BaseModal from '../../components/BaseModal.vue';

const CURRENCY_LABELS: Record<number, string> = { 0: 'UAH', 1: 'USD', 2: 'EUR' };

const { t } = useI18n();
const store = useQuarantineStore();

const filterText = ref('');
const idFilterOpen = ref(false);
const selected = ref<QuarantineView | null>(null);
const paymentId = ref('');

onMounted(() => { void store.load(); });

const filtered = computed(() => {
  const q = filterText.value.trim().toLowerCase();
  if (!q) return store.items;
  return store.items.filter(
    (item) =>
      item.externalRef.toLowerCase().includes(q) ||
      item.quarantineId.toLowerCase().includes(q),
  );
});

function clearFilter(): void {
  filterText.value = '';
  idFilterOpen.value = false;
}

function formatAmount(amount: number, currency: number): string {
  const label = CURRENCY_LABELS[currency] ?? 'UAH';
  return `${(amount / 100).toFixed(2)} ${label}`;
}

function formatDate(val: string | Date): string {
  return new Date(val).toLocaleString();
}

function openBind(item: QuarantineView): void {
  selected.value = item;
  paymentId.value = '';
}

function closeModal(): void {
  selected.value = null;
}

async function doBind(): Promise<void> {
  if (!selected.value) return;
  await store.bind(selected.value.quarantineId, paymentId.value);
  if (!store.error) closeModal();
}
</script>

<template>
  <div class="q-page">
    <BasePanel :title="t('quarantine.title')">
      <div class="toolbar">
        <span class="toolbar__count">{{ filtered.length }} / {{ store.items.length }}</span>
      </div>

      <div v-if="store.loading" class="state-center"><BaseSpinner /></div>
      <p v-else-if="store.error" class="state-error">{{ store.error }}</p>
      <p v-else-if="store.items.length === 0" class="state-empty">
        {{ t('quarantine.noItems') }}
      </p>

      <table v-else class="data-table">
        <thead>
          <tr>
            <th class="th-filter">
              <div class="th-filter__row">
                <span>{{ t('quarantine.externalRef') }}</span>
                <button
                  type="button"
                  class="filter-icon"
                  :class="{ 'filter-icon--active': filterText }"
                  :aria-label="t('quarantine.externalRef')"
                  @click="idFilterOpen = !idFilterOpen"
                >
                  <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
                    <path fill="currentColor" d="M0.5 1.5h15l-6 7v5l-3 1.5v-6.5l-6-7z" />
                  </svg>
                </button>
              </div>
              <div v-if="idFilterOpen" class="th-filter__pop">
                <input
                  v-model="filterText"
                  class="th-filter__input"
                  type="text"
                  :placeholder="t('quarantine.externalRef')"
                />
                <button
                  v-if="filterText"
                  type="button"
                  class="filter-clear"
                  @click="clearFilter"
                >
                  ×
                </button>
              </div>
            </th>
            <th>{{ t('common.amount') }}</th>
            <th>{{ t('quarantine.source') }}</th>
            <th>{{ t('quarantine.occurredAt') }}</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="filtered.length === 0" class="data-row--empty">
            <td colspan="5">{{ t('quarantine.noMatch') }} {{ filterText }}</td>
          </tr>
          <tr v-for="item in filtered" :key="item.quarantineId">
            <td class="mono">{{ item.externalRef }}</td>
            <td class="mono">{{ formatAmount(item.amount, item.currency) }}</td>
            <td>{{ item.source }}</td>
            <td>{{ formatDate(item.occurredAt) }}</td>
            <td class="col-action">
              <BaseButton
                :label="t('common.bind')"
                variant="ghost"
                @click="openBind(item)"
              />
            </td>
          </tr>
        </tbody>
      </table>
    </BasePanel>

    <BaseModal
      :open="selected !== null"
      :title="t('quarantine.bindTitle')"
      @close="closeModal"
    >
      <div class="bind-form">
        <label class="bind-label">{{ t('quarantine.bindLabel') }}</label>
        <BaseInput v-model="paymentId" :placeholder="t('quarantine.bindLabel')" />
        <p v-if="store.error" class="bind-error">{{ store.error }}</p>
        <BaseButton
          :label="t('quarantine.bindButton')"
          :loading="store.loading"
          @click="doBind"
        />
      </div>
    </BaseModal>
  </div>
</template>

<style scoped>
.q-page { display: flex; flex-direction: column; gap: 0; }

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

.state-center { text-align: center; padding: 32px 0; }
.state-error { color: var(--red); padding: 8px 0; font-size: 13px; }
.state-empty { color: var(--dim); padding: 8px 0; font-size: 13px; }

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
.data-table tbody tr:hover td { background: var(--surface-2); }
.col-action { text-align: right; width: 1px; white-space: nowrap; }

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
  width: 200px;
  padding: 6px 8px;
  border: 1px solid var(--line);
  background: var(--bg-2);
  color: var(--text);
  font-family: var(--mono);
  font-size: 12px;
  text-transform: none;
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
</style>
