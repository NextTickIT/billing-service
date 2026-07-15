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
const selected = ref<QuarantineView | null>(null);
const paymentId = ref('');

onMounted(() => { void store.load(); });

const filtered = computed(() => {
  const q = filterText.value.trim().toLowerCase();
  if (!q) return store.items;
  return store.items.filter((item) => {
    const ref = item.externalRef.toLowerCase();
    const id = item.quarantineId.toLowerCase();
    return ref.includes(q) || id.includes(q);
  });
});

function formatAmount(amount: number, currency: number): string {
  const label = CURRENCY_LABELS[currency] ?? 'UAH';
  const major = (amount / 100).toFixed(2);
  return `${major} ${label}`;
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
        <BaseInput
          v-model="filterText"
          :placeholder="t('quarantine.filterPlaceholder')"
          class="toolbar__filter"
        />
      </div>

      <div v-if="store.loading" class="state-center"><BaseSpinner /></div>
      <p v-else-if="store.error" class="state-error">{{ store.error }}</p>
      <p v-else-if="store.items.length === 0" class="state-empty">{{ t('quarantine.noItems') }}</p>
      <p v-else-if="filtered.length === 0" class="state-empty">{{ t('quarantine.noMatch') }}</p>

      <table v-else class="data-table">
        <thead>
          <tr>
            <th>{{ t('quarantine.externalRef') }}</th>
            <th>{{ t('common.amount') }}</th>
            <th>{{ t('quarantine.source') }}</th>
            <th>{{ t('quarantine.occurredAt') }}</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
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
.toolbar__filter { flex: 1; max-width: 320px; }

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

.bind-form { display: flex; flex-direction: column; gap: 10px; }
.bind-label { color: var(--dim); font-size: 12px; }
.bind-error { color: var(--red); font-size: 13px; }
</style>
