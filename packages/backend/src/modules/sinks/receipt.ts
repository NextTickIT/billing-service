import {
  type Currency,
  CurrencyCode,
  PaymentMethod,
} from '@billing-service/shared';
import type { StoredEvent } from '@billing-service/shared';

import { formattedFields } from '@/modules/sinks/formatted.js';

/**
 * The receipt email: subject + HTML + plain text, rendered from an outgoing event.
 *
 * Pure, so the copy is unit-testable without a network or a dashboard. It deliberately
 * reuses `formattedFields` rather than formatting dates again here — the email and the
 * bot message must never disagree about the day a customer is charged.
 *
 * Russian, because the SendPulse flows this sits beside are Russian (see
 * `formatted.ts`: "the SendPulse flows are Russian-language").
 *
 * Styled to match the checkout page, not approximated: every value below is a literal
 * from `packages/frontend/src/styles/tokens.css` and the Base components. The app's
 * default theme is DARK (`:root { color-scheme: dark }`), so the receipt is dark too —
 * a light receipt for a dark product reads like it came from somewhere else.
 *
 * Email-client constraints shape the markup rather than the palette: tables, everything
 * inline (Gmail drops `<style>`), `bgcolor` beside every CSS `background` (Outlook's
 * Word engine ignores the CSS), and `color-scheme` meta so clients do not invert what is
 * already dark. Rounded corners degrade to square in Outlook, which is acceptable.
 * Inter and JetBrains Mono are named first and fall back to system stacks — a receipt
 * must not depend on a webfont request that most clients block. A text/plain part ships
 * with every send: it materially helps inbox placement.
 */

/** Verbatim from `tokens.css` (`:root`, the dark default) and the Base components. */
const T = {
  bg: '#0b0d0f',
  surface: '#15191c',
  surface2: '#1c2126',
  line: '#2a3138',
  text: '#d6d8da',
  muted: '#888d92',
  dim: '#5d6469',
  green: '#7ee787',
  sans: "Inter, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  mono: "ui-monospace, 'JetBrains Mono', Menlo, Consolas, monospace",
} as const;

/**
 * `[data-theme="light"]` from the same file. Applied ONLY through the `<style>` block
 * below, as a `prefers-color-scheme: light` override — never inline, because the inline
 * values must stay dark: that is the app's default theme AND the fallback for every
 * client that strips `<style>`.
 *
 * Support is real but partial: Apple Mail, iOS Mail, Outlook for Mac/iOS and Thunderbird
 * honour the query. **Gmail does not** — it ignores `prefers-color-scheme` and instead
 * force-inverts its own way in mobile dark mode. So this improves the clients that ask
 * politely and changes nothing for the ones that do not.
 */
const L = {
  bg: '#ffffff',
  surface: '#f0f3f6',
  surface2: '#e7ecf1',
  line: '#d4dae0',
  text: '#1f2328',
  muted: '#59636e',
  dim: '#8b949e',
  green: '#1a7f37',
} as const;

/**
 * Class-based light overrides. `!important` is required: these have to beat the inline
 * attributes, which is the whole reason the classes exist.
 */
const THEME_STYLE = `
    <style>
      @media (prefers-color-scheme: light) {
        .e-bg    { background: ${L.bg} !important; }
        .e-panel { background: ${L.surface} !important; border-color: ${L.line} !important; }
        .e-head  { background: ${L.surface2} !important; border-color: ${L.line} !important; color: ${L.muted} !important; }
        .e-title { color: ${L.text} !important; }
        .e-lead  { color: ${L.muted} !important; }
        .e-label { color: ${L.muted} !important; border-color: ${L.line} !important; }
        .e-value { color: ${L.text} !important; border-color: ${L.line} !important; }
        .e-btn   { background: ${L.green} !important; border-color: ${L.green} !important; color: ${L.bg} !important; }
        .e-foot  { color: ${L.dim} !important; border-color: ${L.line} !important; }
        .e-link  { color: ${L.green} !important; }
        .e-legal { color: ${L.dim} !important; }
      }
    </style>`;

const BRAND = 'NextTick';
const SUPPORT_URL = 'https://t.me/next_tick_care_bot';
const TERMS_URL = 'https://nexttick.it/terms';
const PRIVACY_URL = 'https://nexttick.it/privacy';

/** HTML-escape. Every interpolated value passes through this — the URLs come from a
 * caller-supplied `successUrl`/`failureUrl`, so they are untrusted text here. */
const text = (value: unknown): string =>
  typeof value === 'string'
    ? value
    : typeof value === 'number' || typeof value === 'boolean'
      ? String(value)
      : '';

const esc = (value: unknown): string =>
  text(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/** Only ever emit an http(s) link. A stored redirect is validated on write, but a
 * receipt must not be the one place a `javascript:` target reaches a mail client. */
const safeUrl = (value: unknown): string | null => {
  const url = text(value);
  return /^https?:\/\//i.test(url) ? url : null;
};

/** Minor units + currency → "50.00 USD". Money is never re-derived, only formatted. */
const money = (amountMinor: unknown, currency: unknown): string => {
  const minor = Number(amountMinor);
  if (!Number.isFinite(minor)) return '';
  // Guarded rather than `?? ''`: `CurrencyCode` is a total record over the enum, so an
  // out-of-range value would type-check and render "50.00 undefined".
  const code = Object.hasOwn(CurrencyCode, String(currency))
    ? CurrencyCode[currency as Currency]
    : '';
  return `${(minor / 100).toFixed(2)} ${code}`.trim();
};

const methodLabel = (method: unknown): string =>
  method === PaymentMethod.Crypto ? 'Криптовалюта' : 'Карта';

interface Copy {
  readonly subject: string;
  readonly heading: string;
  readonly lead: string;
  readonly actionLabel: string;
  /** Which payload URL this message's button should point at. */
  readonly actionFrom: 'success' | 'failure';
}

/**
 * Per-event copy. An event with no entry here gets no email at all — the connector
 * treats an unmapped event as "not for this channel", which keeps the receipt channel
 * deliberately narrow rather than mirroring every internal event to a customer.
 */
const COPY: Readonly<Record<string, Copy>> = {
  initial_payment_succeeded: {
    subject: `${BRAND} — оплата получена`,
    heading: 'Оплата получена',
    lead: 'Спасибо! Платёж прошёл успешно, подписка активна.',
    actionLabel: 'Открыть доступ',
    actionFrom: 'success',
  },
  recurring_payment_succeeded: {
    subject: `${BRAND} — платёж по подписке получен`,
    heading: 'Платёж получен',
    lead: 'Подписка продлена. Ниже — детали списания.',
    actionLabel: 'Открыть доступ',
    actionFrom: 'success',
  },
  one_time_purchase_succeeded: {
    subject: `${BRAND} — оплата получена`,
    heading: 'Оплата получена',
    lead: 'Спасибо! Платёж прошёл успешно.',
    actionLabel: 'Открыть доступ',
    actionFrom: 'success',
  },
  initial_payment_failed: {
    subject: `${BRAND} — платёж не прошёл`,
    heading: 'Платёж не прошёл',
    lead: 'Списание не удалось, подписка не активирована. Можно попробовать снова.',
    actionLabel: 'Повторить оплату',
    actionFrom: 'failure',
  },
  // A declined prolongation (checkout on a live sub, `/prolong`, manual renewal). The
  // payload carries no `failureUrl`, so in practice this renders without a button.
  recurring_payment_failed: {
    subject: `${BRAND} — платёж не прошёл`,
    heading: 'Продление не прошло',
    lead: 'Списание не удалось, подписка не изменилась. Ссылка на оплату действует до конца срока — можно попробовать снова.',
    actionLabel: 'Повторить оплату',
    actionFrom: 'failure',
  },
  renewal_failed: {
    subject: `${BRAND} — не удалось продлить подписку`,
    heading: 'Не удалось продлить подписку',
    lead: 'Мы не смогли списать платёж за следующий период.',
    actionLabel: 'Обновить оплату',
    actionFrom: 'failure',
  },
  payment_manual_required: {
    subject: `${BRAND} — нужна оплата вручную`,
    heading: 'Нужна оплата вручную',
    lead: 'Криптоподписку нельзя списать автоматически — продлите её по ссылке ниже.',
    actionLabel: 'Оплатить',
    actionFrom: 'failure',
  },
};

export const isReceiptable = (eventName: string): boolean =>
  Object.hasOwn(COPY, eventName);

interface Row {
  readonly label: string;
  readonly value: string;
}

/** The detail rows, built only from values the event actually carries. */
const rowsFor = (
  name: string,
  payload: Record<string, unknown>,
): readonly Row[] => {
  const fmt = formattedFields(payload);
  const out: Row[] = [];
  const amount = money(payload['amount'], payload['currency']);
  if (amount !== '') out.push({ label: 'Сумма', value: amount });
  if (typeof fmt['period_formatted'] === 'string')
    out.push({ label: 'Период', value: fmt['period_formatted'] });
  if (payload['method'] !== undefined)
    out.push({ label: 'Способ оплаты', value: methodLabel(payload['method']) });
  if (typeof fmt['nextPaymentDate_formatted'] === 'string')
    out.push({
      label: 'Следующее списание',
      value: fmt['nextPaymentDate_formatted'],
    });
  if (typeof fmt['nextRetryDate_formatted'] === 'string')
    out.push({
      // On a manual prompt the next ladder date is the charge date the customer is
      // paying towards, not a card retry — "attempt" is our word, not theirs.
      label:
        name === 'payment_manual_required'
          ? 'Дата списания'
          : 'Следующая попытка',
      value: fmt['nextRetryDate_formatted'],
    });
  return out;
};

/**
 * The button target. `manualCheckoutUrl` wins for a manual-pay prompt because it is the
 * link minted for exactly that attempt; otherwise the caller's `successUrl` (a receipt)
 * or `failureUrl` (a retry). No URL at all → no button, and the body still stands on
 * its own, which is why the copy never says "click the button below".
 */
const actionUrlFor = (
  copy: Copy,
  payload: Record<string, unknown>,
): string | null =>
  safeUrl(payload['manualCheckoutUrl']) ??
  safeUrl(payload[copy.actionFrom === 'success' ? 'successUrl' : 'failureUrl']);

const button = (url: string, label: string): string => `
            <tr><td style="padding:20px 16px 4px;">
              <a href="${esc(url)}" class="e-btn" style="display:inline-block;background:${T.green};border:1px solid ${T.green};border-radius:4px;color:${T.bg};font-family:${T.sans};font-size:13px;font-weight:800;line-height:20px;padding:8px 18px;text-decoration:none;">${esc(label)}</a>
            </td></tr>`;

const detailTable = (rows: readonly Row[]): string =>
  rows.length === 0
    ? ''
    : `
            <tr><td style="padding:16px 16px 0;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
                ${rows
                  .map(
                    (r, i) =>
                      `<tr>
                  <td class="e-label" style="padding:9px 0;${i === 0 ? '' : `border-top:1px solid ${T.line};`}font-family:${T.sans};font-size:13px;color:${T.muted};">${esc(r.label)}</td>
                  <td align="right" class="e-value" style="padding:9px 0;${i === 0 ? '' : `border-top:1px solid ${T.line};`}font-family:${T.mono};font-size:13px;color:${T.text};white-space:nowrap;">${esc(r.value)}</td>
                </tr>`,
                  )
                  .join('\n                ')}
              </table>
            </td></tr>`;

export interface RenderedEmail {
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

export const renderReceipt = (event: StoredEvent): RenderedEmail | null => {
  const copy = COPY[event.name];
  if (copy === undefined) return null;
  const payload: Record<string, unknown> = event.payload;
  const rows = rowsFor(event.name, payload);
  const action = actionUrlFor(copy, payload);

  const html = `<!doctype html>
<html lang="ru"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark">
<meta name="supported-color-schemes" content="dark">
<title>${esc(copy.subject)}</title>${THEME_STYLE}
</head>
<body class="e-bg" style="margin:0;padding:0;background:${T.bg};color:${T.text};">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" bgcolor="${T.bg}" class="e-bg" style="background:${T.bg};">
    <tr><td align="center" style="padding:32px 16px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" bgcolor="${T.surface}" class="e-panel" style="max-width:560px;background:${T.surface};border:1px solid ${T.line};border-radius:6px;">
        <tr><td bgcolor="${T.surface2}" class="e-head" style="background:${T.surface2};border-bottom:1px solid ${T.line};padding:10px 16px;font-family:${T.mono};font-size:11px;letter-spacing:0.04em;color:${T.muted};">${esc(BRAND.toUpperCase())}</td></tr>
        <tr><td class="e-title" style="padding:20px 16px 0;font-family:${T.sans};font-size:18px;font-weight:700;color:${T.text};line-height:1.35;">${esc(copy.heading)}</td></tr>
        <tr><td class="e-lead" style="padding:8px 16px 0;font-family:${T.sans};font-size:14px;line-height:1.55;color:${T.muted};">${esc(copy.lead)}</td></tr>${detailTable(rows)}${action === null ? '' : button(action, copy.actionLabel)}
        <tr><td style="padding:20px 16px 18px;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
            <tr><td class="e-foot" style="border-top:1px solid ${T.line};padding:14px 0 0;font-family:${T.sans};font-size:12px;line-height:1.6;color:${T.dim};">
              Вопросы — <a href="${esc(SUPPORT_URL)}" class="e-link" style="color:${T.green};text-decoration:none;">служба заботы</a>.<br>
              <a href="${esc(TERMS_URL)}" class="e-legal" style="color:${T.dim};text-decoration:underline;">Оферта</a> ·
              <a href="${esc(PRIVACY_URL)}" class="e-legal" style="color:${T.dim};text-decoration:underline;">Конфиденциальность</a>
            </td></tr>
          </table>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  const text = [
    `${BRAND} — ${copy.heading}`,
    '',
    copy.lead,
    '',
    ...rows.map((r) => `${r.label}: ${r.value}`),
    ...(action === null ? [] : ['', `${copy.actionLabel}: ${action}`]),
    '',
    `Служба заботы: ${SUPPORT_URL}`,
  ].join('\n');

  return { subject: copy.subject, html, text };
};
