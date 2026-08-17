<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { useQuarantineStore } from './store.js';
import { formatDateTime } from '@/app/datetime.js';
import { useMoney } from '@/app/money.js';
import type { QuarantineView } from './api.js';
import BasePanel from '@/components/BasePanel.vue';
import DataTable from '@/components/DataTable.vue';
import BaseSpinner from '@/components/BaseSpinner.vue';
import BaseButton from '@/components/BaseButton.vue';
import BaseInput from '@/components/BaseInput.vue';
import BaseModal from '@/components/BaseModal.vue';

const { t, locale } = useI18n();
const { formatAmount } = useMoney();
const store = useQuarantineStore();

const selected = ref<QuarantineView | null>(null);
const paymentId = ref('');

onMounted(() => { void store.load(); });

function matchRef(item: QuarantineView, q: string): boolean {
  return (
    item.externalRef.toLowerCase().includes(q) ||
    item.quarantineId.toLowerCase().includes(q)
  );
}
function rowKey(item: QuarantineView): string {
  return item.quarantineId;
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
      <div v-if="store.loading" class="state-center"><BaseSpinner /></div>
      <p v-else-if="store.error" class="state-error">{{ store.error }}</p>

      <DataTable
        v-else
        :items="store.items"
        :filter-label="t('quarantine.externalRef')"
        :filter-match="matchRef"
        :row-key="rowKey"
        :colspan="5"
        :empty-text="t('quarantine.noMatch')"
      >
        <template #head>
          <th>{{ t('common.amount') }}</th>
          <th>{{ t('quarantine.source') }}</th>
          <th>{{ t('quarantine.occurredAt') }}</th>
          <th></th>
        </template>
        <template #row="{ item }">
          <td class="mono">{{ item.externalRef }}</td>
          <td class="mono">{{ formatAmount(item.amount, item.currency) }}</td>
          <td>{{ item.source }}</td>
          <td>{{ formatDateTime(item.occurredAt, locale) }}</td>
          <td class="col-action">
            <BaseButton
              :label="t('common.bind')"
              variant="ghost"
              @click="openBind(item)"
            />
          </td>
        </template>
      </DataTable>
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

.state-center { text-align: center; padding: 32px 0; }
.state-error { color: var(--red); padding: 8px 0; font-size: 13px; }

.col-action { text-align: right; width: 1px; white-space: nowrap; }

.bind-form { display: flex; flex-direction: column; gap: 10px; }
.bind-label { color: var(--dim); font-size: 12px; }
.bind-error { color: var(--red); font-size: 13px; }
</style>
