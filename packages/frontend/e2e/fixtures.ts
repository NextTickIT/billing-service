import { test as base, type Route } from '@playwright/test';

export { expect, type Page } from '@playwright/test';

/** No E2E_BASE_URL means Playwright runs Vite alone, so the API must be faked. */
export const isStubbed = process.env['E2E_BASE_URL'] === undefined;

interface StubReply {
  status: number;
  json: unknown;
}

function signIn(body: string | null): StubReply {
  const { password } = JSON.parse(body ?? '{}') as { password?: string };
  return password === 'wrong'
    ? { status: 401, json: { error: 'Invalid credentials' } }
    : { status: 201, json: {} };
}

// Mirrors only the calls the specs reach: sign-in, and the payment list the
// payments page loads on mount. Anything else is a loud 404, not a silent 200.
function reply(
  method: string,
  pathname: string,
  body: string | null,
): StubReply {
  if (method === 'POST' && pathname === '/api/auth/sessions')
    return signIn(body);
  if (method === 'GET' && pathname === '/api/payment') {
    return { status: 200, json: [] };
  }
  return { status: 404, json: { error: `not stubbed: ${method} ${pathname}` } };
}

const sameOrigin = (url: string, origin: string): boolean =>
  new URL(url).origin === origin;

async function fulfil(route: Route): Promise<void> {
  const request = route.request();
  const { pathname } = new URL(request.url());
  const { status, json } = reply(
    request.method(),
    pathname,
    request.postData(),
  );
  await route.fulfill({ status, json });
}

export const test = base.extend<{ api: undefined }>({
  // `auto` so no spec can forget it: in stubbed mode no request leaves the host.
  api: [
    async ({ page, baseURL }, use) => {
      if (isStubbed) {
        const origin = new URL(baseURL ?? 'http://127.0.0.1:5179').origin;
        // Later routes win, so the catch-all goes first: anything that is not
        // the Vite origin (web fonts, CDNs, another local server) is aborted
        // instead of waited on.
        await page.route('**/*', (route) =>
          sameOrigin(route.request().url(), origin)
            ? route.continue()
            : route.abort(),
        );
        await page.route('**/api/**', fulfil);
      }
      await use(undefined);
    },
    { auto: true },
  ],
});
