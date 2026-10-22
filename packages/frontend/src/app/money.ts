import { useI18n } from 'vue-i18n';
import { Currency } from '@billing-service/shared';

// Currency is the shared enum; its label is a localisation detail owned by the
// i18n `common.currencies` resource (keyed by the enum value), never a JS map
// redefined per page. Amounts are integer minor units rendered as major units.
export function useMoney() {
  const { t } = useI18n();

  const currencyLabel = (currency: Currency): string =>
    t(`common.currencies.${String(currency)}`);

  const formatAmount = (amount: number, currency: Currency): string =>
    `${(amount / 100).toFixed(2)} ${currencyLabel(currency)}`;

  // Buyer-facing price: symbol first, cents only when there are any ($50, $49.50).
  const formatPrice = (amount: number, currency: Currency): string =>
    new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: Currency[currency],
      currencyDisplay: 'narrowSymbol',
      minimumFractionDigits: amount % 100 === 0 ? 0 : 2,
      maximumFractionDigits: 2,
    }).format(amount / 100);

  return { currencyLabel, formatAmount, formatPrice };
}
