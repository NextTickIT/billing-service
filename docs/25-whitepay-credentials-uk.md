# WhitePay: які потрібні ключі та де їх узяти (укр.)

> Довідник для налаштування інтеграції WhitePay (крипто-еквайринг WhiteBIT).
> Ґрунтується на [17-whitepay-research.md](17-whitepay-research.md) та
> [23-whitepay-checkout-selection-research.md](23-whitepay-checkout-selection-research.md),
> звірено з довідками SendPulse / Zenedu (серпень 2026). Офіційна документація
> `docs.whitepay.com` віддає **HTTP 401** анонімним запитам — точні назви полів у
> CRM підтверджуємо вже під робочим акаунтом.

## Коротко: потрібно **три** окремі значення

Інтеграція WhitePay вимагає **трьох різних** ідентифікаторів — це **не** один
«merchant key». Один Bearer-токен сам по собі нічого не відкриває.

| # | Що це | Наша env-змінна | Де брати в CRM | Для чого в коді |
|---|-------|-----------------|----------------|-----------------|
| 1 | **Slug** (ім'я платіжної сторінки / інстансу) | `WHITEPAY_SLUG` | **Payment pages** (Платіжні сторінки) → відкрити сторінку → поле **Slug** | Підставляється в шлях створення замовлення: `POST /private-api/crypto-orders/{slug}` |
| 2 | **Access / API Token** (Bearer) | `WHITEPAY_API_TOKEN` | **Settings → Tokens** → у полі **Access token** натиснути **Generate** | Заголовок `Authorization: Bearer <token>` для серверних викликів API |
| 3 | **Webhook Token** | `WHITEPAY_WEBHOOK_TOKEN` | **Settings → Webhooks** (або **Payment pages → Webhooks**): вставити нашу webhook-адресу → **Save** → скопіювати згенерований **Webhook token** | Ключ для перевірки підпису вебхуків: `HMAC-SHA256(raw body, webhookToken)` проти заголовка `Signature` |

> ⚠️ **Токен вебхука генерується один раз** — скопіюйте його одразу після
> натискання **Save**. Якщо загубили — доведеться перегенерувати (і оновити `.env`).

## Що саме в нас зараз лежить у `.env`

У `.env` є `WHITEPAY_TOKEN`. За словами команди це, найімовірніше, **Webhook Token**
(п.3), а **не** Bearer API-токен. Тому:

- перейменуйте його на `WHITEPAY_WEBHOOK_TOKEN`, якщо це справді токен вебхука;
- **окремо** отримайте `WHITEPAY_API_TOKEN` (Bearer) і `WHITEPAY_SLUG` — без них не
  вийде ані створити замовлення, ані перевірити підпис вебхука.

Як розрізнити на око: Bearer-токен використовується у **вихідних** запитах до
`api.whitepay.com`; Webhook-токен приходить у налаштуваннях вебхука і потрібен для
**вхідних** колбеків. Якщо значення видали в розділі **Webhooks** — це п.3.

## Передумови (без них ключі не видадуть)

1. **Акаунт WhiteBIT + 2FA.** Увімкніть двофакторну автентифікацію: **Settings →
   Security** → відскануйте QR у Google Authenticator → введіть код → **Enable**.
   Без активної 2FA кнопка генерації **Access token** недоступна.
2. **KYB (Know Your Business) — обов'язковий.** API доступний лише **юридичним
   особам / ФОП** (не фізособам). Юридичний відділ WhitePay розглядає заявку **до 5
   робочих днів**, після чого підписується договір крипто-еквайрингу і воркспейс
   активується.
3. **Демо-доступ (швидко).** Через **верифікований акаунт WhiteBIT із 2FA** можна
   зареєструватися і одразу отримати демо-воркспейс (повна функціональність ~24 год),
   щоб згенерувати токени та створити тестове замовлення ще до фінального KYB.

## Як отримати — покроково

### 1. Slug
1. CRM → **Payment pages** (Платіжні сторінки).
2. Створіть або відкрийте платіжну сторінку.
3. Скопіюйте значення поля **Slug** (ім'я інстансу сторінки) → `WHITEPAY_SLUG`.

### 2. Access / API Token (Bearer)
1. Увімкніть 2FA (див. передумови).
2. CRM → **Settings → Tokens**.
3. У полі **Access token** натисніть **Generate** і скопіюйте значення →
   `WHITEPAY_API_TOKEN`.
4. Перевірка: `Authorization: Bearer <token>` має проходити на `api.whitepay.com`.

### 3. Webhook Token
1. CRM → **Settings → Webhooks** (або **Payment pages → Webhooks**).
2. У поле **Webhook address** вставте нашу адресу колбека:
   `https://bill.nexttick.it/api/providers/whitepay/callback`.
3. Натисніть **Save**.
4. Скопіюйте згенерований **Webhook token** → `WHITEPAY_WEBHOOK_TOKEN`
   (**один раз!**).
5. Позначте потрібні події вебхука (щонайменше `order::completed` /
   `order::declined`).

## Куди вписати після отримання (наш `.env`)

```dotenv
# WhitePay (крипто-еквайринг). Вмикається лише коли всі три значення заповнені.
WHITEPAY_ENABLED=true
WHITEPAY_SLUG=<slug платіжної сторінки>
WHITEPAY_API_TOKEN=<Bearer access token>
WHITEPAY_WEBHOOK_TOKEN=<webhook token — той, що зараз у WHITEPAY_TOKEN?>
# Необов'язкові (є дефолти в config.ts):
# WHITEPAY_API_URL=https://api.whitepay.com
# WHITEPAY_SUCCESSFUL_LINK=https://bill.nexttick.it/checkout/{sessionId}/return
# WHITEPAY_FAILURE_LINK=https://bill.nexttick.it/checkout/{sessionId}
```

Поки всі три (`SLUG` + `API_TOKEN` + `WEBHOOK_TOKEN`) не заповнені, лишайте
`WHITEPAY_ENABLED=false`: адаптер зібраний і протестований юніт-тестами, але
крипто-метод на checkout не пропонується і колбек `whitepay` не активний
(той самий підхід, що й gated-off W4P poller/scheduler).

## Питання, які треба закрити на онбордингу (401-gated, звірити під акаунтом)

1. Точний формат тіла `POST /private-api/crypto-orders/{slug}`: очікуємо
   fiat-only `{amount, currency, external_order_id}` (+ optional
   `successful_link`/`failure_link`); монету/мережу обирає **платник** на хостованій
   сторінці — ми їх не передаємо (доки не підтверджено — див. doc 23).
2. Реальний **TTL замовлення / `acquiring_url`** (відомі ~2 хв — це лише вікно
   фіксації курсу, не строк життя замовлення).
3. Семантика ретраїв вебхука (at-least-once?) і точний регістр заголовків
   (`Signature` / `X-Secret-Key`).
4. Чи можна обмежити перелік монет/мереж, доступних платнику.

## Джерела

- SendPulse (наш сінк), інструкція підключення WhitePay (укр.):
  `https://sendpulse.ua/knowledge-base/account-settings/accept-payments/whitepay`
- SendPulse (англ.):
  `https://sendpulse.com/knowledge-base/account-settings/accept-payments/whitepay`
- Zenedu Help Center, «How to connect Whitepay»:
  `https://help.zenedu.io/en/articles/9273269-how-to-connect-whitepay`
- Офіційні (401-gated, звірка під акаунтом): `docs.whitepay.com/docs/http-api/auth`,
  `docs.whitepay.com/docs/http-api/acquiring/crypto`; CRM: `crm.whitepay.com`.
- Внутрішні: [17-whitepay-research.md](17-whitepay-research.md),
  [23-whitepay-checkout-selection-research.md](23-whitepay-checkout-selection-research.md).
