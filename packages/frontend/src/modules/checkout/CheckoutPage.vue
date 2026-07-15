<script setup lang="ts">
import { onMounted, watch } from 'vue';
import { useRoute } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { useCheckoutStore } from './store.js';
import BaseSpinner from '../../components/BaseSpinner.vue';
import BasePanel from '../../components/BasePanel.vue';
import BaseButton from '../../components/BaseButton.vue';

const CURRENCY_LABELS: Record<number, string> = { 0: 'UAH', 1: 'USD', 2: 'EUR' };

// CheckoutSessionStatus enum values
const STATUS_EXPIRED = 3;
const STATUS_COMPLETED = 2;

const { t } = useI18n();
const route = useRoute();
const store = useCheckoutStore();

const id = route.params['id'] as string;

onMounted(() => { void store.load(id); });

function submitW4PForm(action: string, fields: Record<string, string>): void {
  const form = document.createElement('form');
  form.method = 'POST';
  form.action = action;
  for (const [key, val] of Object.entries(fields)) {
    const input = document.createElement('input');
    input.type = 'hidden';
    input.name = key;
    input.value = val;
    form.appendChild(input);
  }
  document.body.appendChild(form);
  form.submit();
}

watch(
  () => store.form,
  (form) => {
    if (form) submitW4PForm(form.action, form.fields);
  },
);

async function onPay(): Promise<void> {
  await store.pay(id);
}

function currencyLabel(c: number): string {
  return CURRENCY_LABELS[c] ?? 'UAH';
}
</script>

<template>
  <div class="checkout-wrap">
    <BasePanel :title="t('checkout.title')">
      <div v-if="store.loading" class="checkout__center">
        <BaseSpinner />
      </div>

      <div v-else-if="store.error" class="checkout__msg checkout__msg--error">
        {{ store.error }}
      </div>

      <template v-else-if="store.session">
        <div
          v-if="store.session.status === STATUS_EXPIRED"
          class="checkout__msg checkout__msg--warn"
        >
          {{ t('checkout.expired') }}
        </div>

        <div
          v-else-if="store.session.status === STATUS_COMPLETED"
          class="checkout__msg checkout__msg--ok"
        >
          {{ t('checkout.completed') }}
        </div>

        <div v-else class="checkout__content">
          <div class="checkout__row">
            <span class="checkout__label">{{ t('common.amount') }}</span>
            <span class="checkout__value">
              {{ store.session.amount }}
              {{ currencyLabel(store.session.currency) }}
            </span>
          </div>
          <div class="checkout__row">
            <span class="checkout__label">{{ t('checkout.periodLabel') }}</span>
            <span class="checkout__value">{{ store.session.period }}</span>
          </div>
          <div class="checkout__row">
            <span class="checkout__label">{{ t('checkout.expiresAt') }}</span>
            <span class="checkout__value">
              {{ new Date(store.session.expiresAt).toLocaleString() }}
            </span>
          </div>
          <div class="checkout__action">
            <BaseButton
              :label="t('checkout.payByCard')"
              :loading="store.loading"
              @click="onPay"
            />
          </div>
        </div>
      </template>
    </BasePanel>
  </div>
</template>

<style scoped>
.checkout-wrap {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  padding: 20px;
}

.checkout-wrap > * {
  width: 100%;
  max-width: 480px;
}

.checkout__center {
  text-align: center;
  padding: 20px 0;
}

.checkout__msg {
  padding: 12px 0;
  font-size: 14px;
}

.checkout__msg--error { color: var(--red); }
.checkout__msg--warn { color: var(--amber); }
.checkout__msg--ok { color: var(--green); }

.checkout__content {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.checkout__row {
  display: flex;
  justify-content: space-between;
  padding: 6px 0;
  border-bottom: 1px solid var(--line);
}

.checkout__label { color: var(--dim); }
.checkout__value { color: var(--txt); }

.checkout__action {
  margin-top: 16px;
}
</style>
