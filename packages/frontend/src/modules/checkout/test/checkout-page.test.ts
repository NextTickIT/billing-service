import {
  type CheckoutSessionPublic,
  CheckoutSessionKind,
  CheckoutSessionStatus,
  Currency,
  PaymentMethod,
} from '@billing-service/shared';
import { createPinia } from 'pinia';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSSRApp } from 'vue';
import { createI18n } from 'vue-i18n';
import { createMemoryHistory, createRouter } from 'vue-router';
import { renderToString } from 'vue/server-renderer';

import en from '@/i18n/locales/en.js';
import ru from '@/i18n/locales/ru.js';
import uk from '@/i18n/locales/uk.js';
import CheckoutPage from '@/modules/checkout/CheckoutPage.vue';
import { afterOptionPick, useCheckoutStore } from '@/modules/checkout/store.js';

const ID = 'chk_0b5e6a3c-1f2d-4c7b-9a8e-1234567890ab';

const single: CheckoutSessionPublic = {
  amount: 5000,
  currency: Currency.USD,
  period: 'P4W',
  recurring: true,
  status: CheckoutSessionStatus.Created,
  kind: CheckoutSessionKind.Checkout,
  method: PaymentMethod.Card,
  successUrl: null,
  failureUrl: null,
  expiresAt: new Date('2030-01-01T00:00:00Z'),
  renewal: null,
  methodLocked: false,
  prolong: false,
  options: [
    { amount: 5000, period: 'P4W', promo: null, renewal: null, cycles: null },
  ],
  defaultOption: 0,
};

const callerOptions: CheckoutSessionPublic = {
  ...single,
  options: [
    { amount: 5000, period: 'P4W', promo: null, renewal: null, cycles: null },
    {
      amount: 13000,
      period: 'P12W',
      promo: { additionalFreePeriod: 'P7D' },
      renewal: null,
      cycles: null,
    },
    { amount: 9000, period: 'P1M', promo: null, renewal: null, cycles: null },
  ],
};

// `P0D` is the "no bonus days" promo: it adds nothing, so there is nothing to badge.
const zeroPromo: CheckoutSessionPublic = {
  ...single,
  options: [
    {
      amount: 5000,
      period: 'P4W',
      promo: { additionalFreePeriod: 'P0D' },
      renewal: null,
      cycles: null,
    },
    { amount: 9000, period: 'P1M', promo: null, renewal: null, cycles: null },
  ],
};

const cycles: CheckoutSessionPublic = {
  ...single,
  options: [1, 3, 6].map((n) => ({
    amount: 5000 * n,
    period: `P${String(4 * n)}W`,
    promo: null,
    renewal: null,
    cycles: n,
  })),
};

/** Render the page server-side over a store already holding `session`. */
const render = async (
  session: CheckoutSessionPublic,
  locale = 'uk',
): Promise<string> => {
  // Same as app/main.ts: the linter's type service does not read .vue files.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
  const app = createSSRApp(CheckoutPage);
  const pinia = createPinia();
  app.use(pinia);
  useCheckoutStore(pinia).session = session;
  app.use(createI18n({ legacy: false, locale, messages: { en, ru, uk } }));
  const router = createRouter({
    history: createMemoryHistory(),
    // The page reads its id from the route; it is the app root, not the route's view.
    routes: [{ path: '/checkout/:id', component: { render: () => null } }],
  });
  // Navigate before installing: under a DOM environment `app.use(router)` would
  // otherwise start an initial navigation to the memory history's empty path.
  await router.push(`/checkout/${ID}`);
  app.use(router);
  await router.isReady();
  return renderToString(app);
};

/** The text of the "Сума" row (scoped-style attributes stripped first). */
const amountRow = (html: string): string =>
  /Сума<\/span><span class="checkout__value">([^<]*)</
    .exec(html.replace(/ data-v-[0-9a-f]+/g, ''))?.[1]
    ?.trim() ?? '';

describe('CheckoutPage', () => {
  it('a single option renders the page as it always was: no picker', async () => {
    const html = await render(single);
    expect(html).not.toContain('checkout__options');
    expect(html).toContain('Розрахунковий період');
    expect(amountRow(html)).toBe('$50');
  });

  it('caller options: multiples of 4 weeks in starred cycles, others by period', async () => {
    const html = await render(callerOptions);
    expect(html.match(/type="radio"/g)).toHaveLength(3);
    expect(html).toContain('1 цикл*');
    expect(html).toContain('3 цикли*');
    // P1M is not a multiple of P4W: shown as its own period, unstarred.
    expect(html).toContain('1 місяць');
    expect(html).not.toContain('1 місяць*');
    expect(html).toContain('+7 днів');
    expect(html).toMatch(/\*\s*1 цикл = 4 тижні/);
  });

  it('a P0D promo adds no days, so its option shows no bonus badge', async () => {
    const html = await render(zeroPromo);
    expect(html.match(/type="radio"/g)).toHaveLength(2);
    expect(html).not.toContain('checkout__badge');
    expect(html).not.toContain('P0D');
  });

  it('manual-renewal cycles are starred, with the cycle footnote', async () => {
    const html = await render(cycles);
    expect(html).toContain('6 циклів*');
    expect(html).toMatch(/\*\s*1 цикл = 4 тижні/);
  });

  it('a renewal of one cycle reads "per cycle", priced with the symbol', async () => {
    const html = await render({
      ...callerOptions,
      defaultOption: 1,
      options: callerOptions.options.map((o, i) =>
        i === 1 ? { ...o, renewal: { amount: 5000, period: 'P4W' } } : o,
      ),
    });
    expect(html).toContain('Далі $50 за цикл*');
    expect(html).not.toContain('USD');
  });

  it('"Сума" shows the selected option, the default when the page opens', async () => {
    expect(amountRow(await render(callerOptions))).toBe('$50');
    expect(
      amountRow(await render({ ...callerOptions, defaultOption: 1 })),
    ).toBe('$130');
  });

  it('cycle options use the language’s plural forms', async () => {
    const uk = await render(cycles);
    expect(uk).toContain('1 цикл');
    expect(uk).toContain('3 цикли');
    expect(uk).toContain('6 циклів');
    const ru = await render(cycles, 'ru');
    expect(ru).toContain('3 цикла');
    expect(ru).toContain('6 циклов');
    const en = await render(cycles, 'en');
    expect(en).toContain('1 cycle');
    expect(en).toContain('6 cycles');
  });
});

describe('pay', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends the picked option to /pay', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(
        new Response(JSON.stringify({ kind: 'redirect', url: 'https://p' })),
      ),
    );
    vi.stubGlobal('fetch', fetch);
    const store = useCheckoutStore(createPinia());
    await store.pay(ID, PaymentMethod.Crypto, 2);
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe(`/api/checkout-sessions/${ID}/pay`);
    expect(JSON.parse(init?.body as string)).toEqual({
      method: PaymentMethod.Crypto,
      option: 2,
    });
  });
});

describe('option refusals', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const refuse = (code: string) => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof globalThis.fetch>(() =>
        Promise.resolve(
          new Response(JSON.stringify({ error: 'refused', code }), {
            status: 409,
          }),
        ),
      ),
    );
  };

  it('an already-subscribed refusal of one option clears when another is picked', async () => {
    refuse('already_subscribed');
    const store = useCheckoutStore(createPinia());
    store.session = callerOptions;
    await store.pay(ID, PaymentMethod.Card, 1);
    expect(store.notice).toMatchObject({
      key: 'checkout.errors.alreadySubscribed',
      retryable: false,
    });
    store.notice = afterOptionPick(store.notice);
    expect(store.notice).toBeNull();
  });

  it('on a single-option page the refusal is session-wide and stays', async () => {
    refuse('already_subscribed');
    const store = useCheckoutStore(createPinia());
    store.session = single;
    await store.pay(ID, PaymentMethod.Card, 0);
    store.notice = afterOptionPick(store.notice);
    expect(store.notice?.key).toBe('checkout.errors.alreadySubscribed');
  });

  it('an unavailable option is retryable and clears on the next pick', async () => {
    refuse('option_unavailable');
    const store = useCheckoutStore(createPinia());
    store.session = callerOptions;
    await store.pay(ID, PaymentMethod.Card, 1);
    expect(store.notice).toMatchObject({
      key: 'checkout.notices.optionUnavailable',
      retryable: true,
    });
    store.notice = afterOptionPick(store.notice);
    expect(store.notice).toBeNull();
  });
});
