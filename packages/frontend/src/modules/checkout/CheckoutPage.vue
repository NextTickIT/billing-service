<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { useI18n } from 'vue-i18n';
import {
  type CheckoutOptionPublic,
  CheckoutSessionKind,
  CheckoutSessionStatus,
  formatPeriod,
  isRenderablePeriod,
  PaymentMethod,
  sessionIdOfRef,
} from '@billing-service/shared';
import { afterOptionPick, useCheckoutStore } from './store.js';
import { formatDate } from '@/app/datetime.js';
import { useMoney } from '@/app/money.js';
import BaseSpinner from '@/components/BaseSpinner.vue';
import BasePanel from '@/components/BasePanel.vue';
import BaseButton from '@/components/BaseButton.vue';
import LangSwitch from '@/components/LangSwitch.vue';
import ThemeToggle from '@/components/ThemeToggle.vue';

const { t, locale } = useI18n();
const { formatPrice } = useMoney();
const route = useRoute();
const store = useCheckoutStore();

// A provider's failure link brings the payer back with its order reference, which names
// the option after the session id (`chk_<uuid>_c3`); the page is the session's.
const id = sessionIdOfRef(route.params['id'] as string);

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

// Crypto (WhitePay) is offered whenever the build flag is on — both methods are shown on
// every checkout so a buyer can pick crypto even when the checkout didn't preselect it
// (the backend `pay` route honors whichever method the buyer picks). Kept dark until the
// WhitePay slug + API token + webhook token are provisioned (VITE_WHITEPAY_ENABLED — docs/25).
const cryptoOffered = computed(
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

// The methods the picker offers: Card always; Crypto whenever WhitePay is enabled. A
// locked session (a prolong link, fixed to the subscription's method) offers only its
// own method, so the picker hides.
const methods = computed<PaymentMethod[]>(() => {
  const session = store.session;
  if (session?.methodLocked && session.method !== null) return [session.method];
  return cryptoOffered.value
    ? [PaymentMethod.Card, PaymentMethod.Crypto]
    : [PaymentMethod.Card];
});

// Locked to crypto while this build does not offer crypto: there is nothing the buyer
// can pay with, so show the "unavailable" state rather than quietly offering card (the
// server would refuse card anyway).
const lockedUnavailable = computed(
  () =>
    store.session?.methodLocked === true &&
    store.session.method === PaymentMethod.Crypto &&
    !cryptoOffered.value,
);

function methodLabel(method: PaymentMethod): string {
  return method === PaymentMethod.Crypto
    ? t('checkout.methodCrypto')
    : t('checkout.methodCard');
}

// The user's current pick. Seeded from the session's default method once it loads,
// falling back to Card if that default isn't offered (e.g. a Crypto default while
// crypto is build-disabled).
const selectedMethod = ref<PaymentMethod>(PaymentMethod.Card);

watch(
  () => store.session,
  (session) => {
    if (!session) return;
    const preferred = session.method ?? PaymentMethod.Card;
    selectedMethod.value = methods.value.includes(preferred)
      ? preferred
      : PaymentMethod.Card;
  },
  { immediate: true },
);

// The options the payer picks from; one entry (the flat terms) when there is no choice,
// and the page then reads exactly as a single-offer page always has.
const options = computed<readonly CheckoutOptionPublic[]>(
  () => store.session?.options ?? [],
);

// The picked option's index. Seeded with the default once, and kept across a session
// refresh (a method-locked refusal swaps the session in) so the payer's pick survives.
const selectedOption = ref<number | null>(null);

watch(
  () => store.session,
  (session) => {
    if (!session) return;
    const current = selectedOption.value;
    if (current === null || current >= session.options.length) {
      selectedOption.value = session.defaultOption;
    }
  },
  { immediate: true },
);

// A refused option sends the page back to the link's default, which is what the
// replacement still sells; the notice stays until the buyer picks again.
watch(
  () => store.notice,
  (notice) => {
    if (notice?.key === 'checkout.notices.optionUnavailable' && store.session)
      selectedOption.value = store.session.defaultOption;
  },
);

const selected = computed<CheckoutOptionPublic | null>(
  () =>
    options.value[selectedOption.value ?? store.session?.defaultOption ?? 0] ??
    null,
);

// A cycle is 4 weeks on caller options; a manual renewal's cycle is the sub's own
// period (its options carry `cycles`). Options in cycles are starred and the note
// under the Pay row says what one cycle is; any other period is shown as is.
const CYCLE_WEEKS = 4;

const base = computed<CheckoutOptionPublic | null>(
  () => options.value[store.session?.defaultOption ?? 0] ?? null,
);

const manualCycles = computed(() =>
  options.value.some((o) => o.cycles !== null),
);

function cyclesOf(option: CheckoutOptionPublic): number | null {
  if (option.cycles !== null) return option.cycles;
  const weeks = Number(/^P(\d+)W$/.exec(option.period)?.[1] ?? 0);
  return weeks > 0 && weeks % CYCLE_WEEKS === 0 ? weeks / CYCLE_WEEKS : null;
}

// Plural forms come from Intl, not a rule table: uk/ru need one / few / many.
function optionLabel(option: CheckoutOptionPublic): string {
  const n = cyclesOf(option);
  if (n !== null) {
    const form = new Intl.PluralRules(locale.value).select(n);
    return `${t(`checkout.cycles.${form}`, { n })}*`;
  }
  return isRenderablePeriod(option.period)
    ? formatPeriod(option.period, locale.value)
    : '';
}

const labelledInCycles = computed(() =>
  options.value.some((o) => cyclesOf(o) !== null),
);

const cyclePeriod = computed(() =>
  manualCycles.value && base.value ? base.value.period : `P${CYCLE_WEEKS}W`,
);

// "Then $50 per cycle*" when the renewal runs one cycle at a time.
const renewalPerCycle = computed(
  () => selected.value?.renewal?.period === cyclePeriod.value,
);

const showCycleNote = computed(
  () =>
    store.session?.recurring === true &&
    (renewalPerCycle.value ||
      (options.value.length > 1 && labelledInCycles.value)),
);

async function onPay(): Promise<void> {
  await store.pay(id, selectedMethod.value, selectedOption.value ?? undefined);
}

// Legal documents (Offer / Privacy / Data consent), hosted on the marketing site,
// linked below the Pay button so the buyer accepts them at the point of payment.
const legalLinks = [
  { key: 'checkout.legalOffer', url: 'https://nexttick.it/offer.html' },
  { key: 'checkout.legalPrivacy', url: 'https://nexttick.it/privacy.html' },
  { key: 'checkout.legalConsent', url: 'https://nexttick.it/consent.html' },
] as const;
</script>

<template>
  <div class="checkout-wrap">
    <BasePanel
      :title="
        store.session?.prolong
          ? t('checkout.titleProlong')
          : t('checkout.title')
      "
    >
      <template #actions>
        <LangSwitch />
        <ThemeToggle />
      </template>
      <div v-if="store.loading" class="checkout__center">
        <BaseSpinner />
      </div>

      <div v-else-if="store.error" class="checkout__msg checkout__msg--error">
        {{ t(store.error) }}
        <span v-if="store.errorDetail" class="checkout__msg-detail">
          {{ store.errorDetail }}
        </span>
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
          <p class="checkout__kind">
            {{
              store.session.recurring
                ? t('checkout.typeSubscription')
                : t('checkout.typeOneTime')
            }}
          </p>
          <div
            v-if="options.length > 1"
            class="checkout__options"
            role="radiogroup"
            :aria-label="
              store.session.recurring
                ? t('checkout.typeSubscription')
                : t('checkout.typeOneTime')
            "
          >
            <label
              v-for="(o, i) in options"
              :key="i"
              class="checkout__option"
              :class="{ 'checkout__option--on': selectedOption === i }"
            >
              <input
                v-model="selectedOption"
                type="radio"
                name="checkout-option"
                :value="i"
                :disabled="store.submitting"
                @change="store.notice = afterOptionPick(store.notice)"
              />
              <span class="checkout__option-label">{{ optionLabel(o) }}</span>
              <span v-if="o.promo" class="checkout__badge">
                {{
                  t('checkout.bonus', {
                    period: formatPeriod(o.promo.additionalFreePeriod, locale),
                  })
                }}
              </span>
              <span class="checkout__option-amount">
                {{ formatPrice(o.amount, store.session.currency) }}
              </span>
            </label>
          </div>
          <div class="checkout__row">
            <span class="checkout__label">{{ t('common.amount') }}</span>
            <span class="checkout__value">
              {{
                formatPrice(
                  selected?.amount ?? store.session.amount,
                  store.session.currency,
                )
              }}
            </span>
          </div>
          <div
            v-if="store.session.recurring && options.length <= 1"
            class="checkout__row"
          >
            <span class="checkout__label">{{ t('checkout.periodLabel') }}</span>
            <span class="checkout__value">
              {{ formatPeriod(store.session.period, locale) }}
            </span>
          </div>
          <p
            v-if="store.session.recurring && selected?.renewal"
            class="checkout__renewal"
          >
            {{
              renewalPerCycle
                ? t('checkout.renewalPerCycle', {
                    amount: formatPrice(
                      selected.renewal.amount,
                      store.session.currency,
                    ),
                  })
                : t('checkout.renewalThen', {
                    amount: formatPrice(
                      selected.renewal.amount,
                      store.session.currency,
                    ),
                    period: formatPeriod(selected.renewal.period, locale),
                  })
            }}
          </p>
          <p class="checkout__expiry">
            {{
              t('checkout.linkValidUntil', {
                date: formatDate(store.session.expiresAt, locale),
              })
            }}
          </p>
          <div
            v-if="store.notice"
            class="checkout__msg checkout__msg--warn"
            role="status"
          >
            {{ t(store.notice.key) }}
          </div>
          <div
            v-if="lockedUnavailable"
            class="checkout__msg checkout__msg--warn"
          >
            {{ t('checkout.errors.unavailable') }}
          </div>
          <div
            v-else-if="!store.notice || store.notice.retryable"
            class="checkout__pay"
          >
            <div
              v-if="methods.length > 1"
              class="checkout__methods"
              role="group"
              :aria-label="t('checkout.method')"
            >
              <BaseButton
                v-for="m in methods"
                :key="m"
                :label="methodLabel(m)"
                :variant="selectedMethod === m ? 'primary' : 'ghost'"
                :disabled="store.submitting"
                @click="selectedMethod = m"
              />
            </div>
            <BaseButton
              class="checkout__paybtn"
              :label="t('checkout.pay')"
              :loading="store.submitting"
              @click="onPay()"
            />
          </div>
          <div class="checkout__legal">
            <p v-if="showCycleNote" class="checkout__legal-note">
              *
              {{
                t('checkout.cycleIs', {
                  period: formatPeriod(cyclePeriod, locale),
                })
              }}
            </p>
            <p class="checkout__legal-note">{{ t('checkout.legalNote') }}</p>
            <p class="checkout__legal-links">
              <template v-for="(l, i) in legalLinks" :key="l.url">
                <a :href="l.url" target="_blank" rel="noopener noreferrer">{{
                  t(l.key)
                }}</a
                ><span v-if="i < legalLinks.length - 1"> · </span>
              </template>
            </p>
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
/* Provider-written detail (422 only) — secondary to the translated line above it. */
.checkout__msg-detail {
  display: block;
  margin-top: 0.35rem;
  font-size: 0.875em;
  opacity: 0.8;
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

/* What is being sold, above the figures that quantify it — a caption, not a row:
   it has no counterpart value to align against. */
.checkout__kind {
  margin: 0;
  font-size: 13px;
  color: var(--muted);
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

/* The renewal terms, when they differ from the first charge: a caption under the
   figures it qualifies, not another row. */
.checkout__renewal {
  margin: 0;
  font-size: 13px;
  color: var(--muted);
}

/* The option picker: one row per option, its label, any promo badge, and its price. */
.checkout__options {
  display: flex;
  flex-direction: column;
  gap: 14px;
  margin-bottom: 8px;
}
.checkout__option {
  position: relative;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 16px;
  border: 1px solid var(--line);
  border-radius: 6px;
  cursor: pointer;
}
.checkout__option input {
  accent-color: var(--green);
}
.checkout__option--on {
  border: 2px solid var(--green);
  padding: 13px 15px;
}
.checkout__option-label {
  color: var(--txt);
}
/* The promo pill sits on the row's top edge, right-aligned. */
.checkout__badge {
  position: absolute;
  top: -10px;
  right: 14px;
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--red);
  color: #fff;
  font-size: 12px;
  font-weight: 600;
  line-height: 1.4;
}
.checkout__option-amount {
  margin-left: auto;
  color: var(--txt);
}

/* The link's own TTL is checkout housekeeping, not a term of the purchase: smaller and
   dimmer than the figures above it so it never reads as another product fact. */
.checkout__expiry {
  margin: 2px 0 0;
  font-size: 12px;
  color: var(--dim);
}

.checkout__pay {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 16px;
}

.checkout__methods {
  display: flex;
  gap: 8px;
}

/* Keep Pay right-aligned whether or not the method picker is shown. */
.checkout__paybtn {
  margin-left: auto;
}

.checkout__legal {
  margin-top: 14px;
  font-size: 12px;
  line-height: 1.6;
  text-align: center;
  color: var(--dim);
}
.checkout__legal-note {
  margin: 0;
}
.checkout__legal-links {
  margin: 2px 0 0;
}
.checkout__legal a {
  color: var(--dim);
  text-decoration: underline;
}
.checkout__legal a:hover {
  color: var(--txt);
}
</style>
