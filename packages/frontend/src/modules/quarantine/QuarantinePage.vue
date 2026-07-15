<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { useQuarantineStore } from './store.js';
import type { QuarantineRecord } from './api.js';
import BaseSpinner from '../../components/BaseSpinner.vue';
import BaseButton from '../../components/BaseButton.vue';
import BaseInput from '../../components/BaseInput.vue';
import BaseModal from '../../components/BaseModal.vue';

const { t } = useI18n();
const store = useQuarantineStore();

const selected = ref<QuarantineRecord | null>(null);
const paymentId = ref('');

onMounted(() => { void store.load(); });

function openBind(item: QuarantineRecord): void {
  selected.value = item;
  paymentId.value = '';
}

function closeModal(): void {
  selected.value = null;
}

async function doBind(): Promise<void> {
  if (!selected.value) return;
  await store.bind(selected.value.id, paymentId.value);
  if (!store.error) closeModal();
}
</script>

<template>
  <div class="q-page">
    <h1 class="q-title">{{ t('quarantine.title') }}</h1>

    <div v-if="store.loading" class="q-center"><BaseSpinner /></div>
    <p v-else-if="store.error" class="q-error">{{ store.error }}</p>
    <p v-else-if="store.items.length === 0" class="q-empty">{{ t('quarantine.noItems') }}</p>

    <table v-else class="q-table">
      <thead>
        <tr>
          <th>{{ t('quarantine.externalRef') }}</th>
          <th>{{ t('quarantine.source') }}</th>
          <th>{{ t('common.status') }}</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="item in store.items" :key="item.id">
          <td>{{ item.externalRef ?? '—' }}</td>
          <td>{{ item.source }}</td>
          <td>{{ item.createdAt }}</td>
          <td>
            <BaseButton
              :label="t('common.bind')"
              variant="ghost"
              @click="openBind(item)"
            />
          </td>
        </tr>
      </tbody>
    </table>

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
.q-page { padding: 20px; }
.q-title { font-size: 18px; margin-bottom: 16px; }
.q-center { text-align: center; padding: 20px 0; }
.q-error { color: var(--red); padding: 8px 0; }
.q-empty { color: var(--dim); padding: 8px 0; }
.q-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.q-table th {
  padding: 6px 10px; text-align: left; color: var(--dim);
  border-bottom: 1px solid var(--line); white-space: nowrap; font-size: 12px;
}
.q-table td { padding: 7px 10px; border-bottom: 1px solid var(--line); }
.bind-form { display: flex; flex-direction: column; gap: 10px; }
.bind-label { color: var(--dim); font-size: 12px; }
.bind-error { color: var(--red); font-size: 13px; }
</style>
