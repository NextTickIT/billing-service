/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** 'true' surfaces the crypto (WhitePay) pay option on the checkout page. Kept off
   * until the WhitePay slug + API token + webhook token are provisioned (docs/25). */
  readonly VITE_WHITEPAY_ENABLED?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
