<script setup lang="ts">
import { computed, onMounted, watch } from 'vue';
import { useRoute } from 'vue-router';
import { useI18n } from 'vue-i18n';
import {
  CheckoutSessionKind,
  CheckoutSessionStatus,
  PaymentMethod,
} from '@billing-service/shared';
import { useCheckoutStore } from './store.js';
import { formatDate } from '@/app/datetime.js';
import { useMoney } from '@/app/money.js';
import BaseSpinner from '@/components/BaseSpinner.vue';
import BasePanel from '@/components/BasePanel.vue';
import BaseButton from '@/components/BaseButton.vue';
import LangSwitch from '@/components/LangSwitch.vue';
import ThemeToggle from '@/components/ThemeToggle.vue';

const { t, locale } = useI18n();
const { formatAmount } = useMoney();
const route = useRoute();
const store = useCheckoutStore();

const id = route.params['id'] as string;

// A 0-amount card change is a WayForPay Card Verify: the cardholder enters the new
// card in the provider's hosted widget, not our page. It hands off the SAME way as a
// normal Purchase — we fetch a signed form (POST /pay) and the browser posts it
// directly to WayForPay — the only difference being that a verify needs no button, so
// we auto-start the handoff the moment the session loads.
const isVerify = computed(
  () =>
    store.session?.kind === CheckoutSessionKind.CardChange &&
    store.session.amount === 0,
);

const isPayable = computed(
  () =>
    store.session?.status !== CheckoutSessionStatus.Completed &&
    store.session?.status !== CheckoutSessionStatus.Expired,
);

// Crypto (WhitePay) is surfaced only when the build flag is on — kept dark until the
// slug + API token + webhook token are provisioned (docs/25).
const cryptoEnabled = computed(
  () => import.meta.env.VITE_WHITEPAY_ENABLED === 'true',
);

onMounted(() => {
  void store.load(id);
});

watch(
  () => store.session,
  () => {
    if (isVerify.value && isPayable.value) {
      // Fetch the verify form via POST /pay; the `watch(() => store.instruction)`
      // below submits it to WayForPay, exactly like a user-clicked Purchase.
      void store.pay(id);
    }
  },
);

function submitW4PForm(action: string, fields: Record<string, unknown>): void {
  const form = document.createElement('form');
  form.method = 'POST';
  form.action = action;
  for (const [key, val] of Object.entries(fields)) {
    const input = document.createElement('input');
    input.type = 'hidden';
    input.name = key;
    input.value = String(val);
    form.appendChild(input);
  }
  document.body.appendChild(form);
  form.submit();
}

// A card method hands back a form to POST to WayForPay; a crypto method hands back a
// redirect to the WhitePay hosted page. Both navigate away, so the button stays busy.
watch(
  () => store.instruction,
  (instruction) => {
    if (!instruction) return;
    if (instruction.kind === 'form') {
      submitW4PForm(instruction.action, instruction.fields);
    } else {
      window.location.assign(instruction.url);
    }
  },
);

async function onPay(
  method: PaymentMethod = PaymentMethod.Card,
): Promise<void> {
  await store.pay(id, method);
}
</script>

<template>
  <div class="checkout-wrap">
    <BasePanel :title="t('checkout.title')">
      <template #actions>
        <LangSwitch />
        <ThemeToggle />
      </template>
      <div v-if="store.loading" class="checkout__center">
        <BaseSpinner />
      </div>

      <div v-else-if="store.error" class="checkout__msg checkout__msg--error">
        {{ store.error }}
      </div>

      <template v-else-if="store.session">
        <div
          v-if="store.session.status === CheckoutSessionStatus.Expired"
          class="checkout__msg checkout__msg--warn"
        >
          {{ t('checkout.expired') }}
        </div>

        <div
          v-else-if="store.session.status === CheckoutSessionStatus.Completed"
          class="checkout__msg checkout__msg--ok"
        >
          {{ t('checkout.completed') }}
        </div>

        <div v-else-if="isVerify" class="checkout__msg">
          {{ t('checkout.redirecting') }}
        </div>

        <div v-else class="checkout__content">
          <div class="checkout__row">
            <span class="checkout__label">{{ t('common.amount') }}</span>
            <span class="checkout__value">
              {{ formatAmount(store.session.amount, store.session.currency) }}
            </span>
          </div>
          <div class="checkout__row">
            <span class="checkout__label">{{ t('checkout.expiresAt') }}</span>
            <span class="checkout__value">
              {{ formatDate(store.session.expiresAt, locale) }}
            </span>
          </div>
          <div class="checkout__action">
            <BaseButton
              :label="t('checkout.payByCard')"
              :loading="store.submitting"
              @click="onPay(PaymentMethod.Card)"
            />
            <BaseButton
              v-if="cryptoEnabled"
              :label="t('checkout.payByCrypto')"
              :loading="store.submitting"
              @click="onPay(PaymentMethod.Crypto)"
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

.checkout__msg--error {
  color: var(--red);
}
.checkout__msg--warn {
  color: var(--amber);
}
.checkout__msg--ok {
  color: var(--green);
}

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

.checkout__label {
  color: var(--dim);
}
.checkout__value {
  color: var(--txt);
}

.checkout__action {
  margin-top: 16px;
}
</style>
