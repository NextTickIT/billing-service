import { computed } from 'vue';
import { Currency, PaymentMethod } from '@billing-service/shared';
import { useMoney } from '@/app/money.js';

interface SelectOption<V> {
  value: V;
  label: string;
}

// The currencies / methods / periods the create form offers. Values come from
// the shared enums (never magic numbers); currency labels are localised. Shared
// so every form that creates a payment agrees on what is supported.
const SUPPORTED_CURRENCIES: readonly Currency[] = [Currency.UAH, Currency.USD];

const METHOD_OPTIONS: SelectOption<PaymentMethod>[] = [
  { value: PaymentMethod.Card, label: 'Card' },
];

const PERIOD_OPTIONS: SelectOption<string>[] = [
  { value: 'P4W', label: '4 weeks' },
];

export function usePaymentOptions() {
  const { currencyLabel } = useMoney();

  const currencyOptions = computed<SelectOption<Currency>[]>(() =>
    SUPPORTED_CURRENCIES.map((c) => ({ value: c, label: currencyLabel(c) })),
  );

  return {
    currencyOptions,
    methodOptions: METHOD_OPTIONS,
    periodOptions: PERIOD_OPTIONS,
  };
}
