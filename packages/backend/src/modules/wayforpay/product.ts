/**
 * The product line a buyer sees on the WayForPay page, in the receipt WayForPay
 * mails, and on their card statement.
 *
 * Every subscription is sold under one name whatever its billing period: the thing
 * being bought is membership of the community, and "monthly" is how it is marketed,
 * not a restatement of the cadence (a P4W plan is still "the monthly subscription").
 * A one-time purchase keeps the bare period-stamped label it always had.
 */
export const SUBSCRIPTION_PRODUCT_NAME =
  'Monthly subscription to the NextTick Guild community';

export const productNameFor = (p: {
  readonly recurring: boolean;
  readonly period: string;
}): string => (p.recurring ? SUBSCRIPTION_PRODUCT_NAME : `Payment ${p.period}`);
