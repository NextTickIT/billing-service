interface Env {
  BACKEND_ORIGIN: string;
  BFF_SECRET: string;
}

interface EventContext<E, D> {
  request: Request;
  env: E;
  params: Record<string, string | string[]>;
  data: D;
  next: (input?: Request | string) => Promise<Response>;
}

type PagesFunction<E> = (
  context: EventContext<E, Record<string, unknown>>,
) => Promise<Response>;

const BSS_COOKIE = 'bss';
const BSS_MAX_AGE = 3600;

function extractCookie(request: Request, name: string): string | null {
  const header = request.headers.get('cookie') ?? '';
  const match = new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(header);
  return match?.[1] ?? null;
}

function requiresOperatorAuth(pathname: string): boolean {
  return (
    pathname.startsWith('/api/payment') ||
    pathname.startsWith('/api/quarantine') ||
    pathname.startsWith('/api/sinks') ||
    pathname.startsWith('/api/support')
  );
}

function unauthorizedResponse(): Response {
  return new Response(JSON.stringify({ error: 'Unauthorized' }), {
    status: 401,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Forward a request to the backend with the BFF secret and optional bearer.
 * Body is buffered (not streamed) so the call works in both the Cloudflare
 * Workers runtime and Node.js (which requires `duplex` for streaming bodies). */
async function forwardToBackend(
  request: Request,
  backendUrl: string,
  secret: string,
  bearerToken: string | null,
): Promise<Response> {
  const headers = new Headers(request.headers);
  if (secret.length > 0) headers.set('x-bff-secret', secret);
  if (bearerToken !== null) {
    headers.set('authorization', `Bearer ${bearerToken}`);
  }
  const body =
    request.body !== null ? await request.arrayBuffer() : null;
  return fetch(backendUrl, {
    method: request.method,
    headers,
    body,
  });
}

function bssSetCookie(token: string): string {
  return `${BSS_COOKIE}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${String(BSS_MAX_AGE)}`;
}

function bssClearCookie(): string {
  return `${BSS_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`;
}

async function handleLogin(
  request: Request,
  origin: string,
  secret: string,
): Promise<Response> {
  const headers = new Headers(request.headers);
  if (secret.length > 0) headers.set('x-bff-secret', secret);
  const body = await request.arrayBuffer();
  const upstream = await fetch(`${origin}/auth/sessions`, {
    method: 'POST',
    headers,
    body,
  });
  if (!upstream.ok) {
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  const data = (await upstream.json()) as { token?: string };
  const token = data.token ?? '';
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': bssSetCookie(token),
    },
  });
}

function handleLogout(): Response {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': bssClearCookie(),
    },
  });
}

export const onRequest: PagesFunction<Env> = async (context) => {
  const { request, env } = context;
  const { pathname } = new URL(request.url);
  const secret = env.BFF_SECRET;

  if (request.method === 'POST' && pathname === '/api/auth/sessions') {
    return handleLogin(request, env.BACKEND_ORIGIN, secret);
  }

  if (request.method === 'POST' && pathname === '/api/auth/logout') {
    return handleLogout();
  }

  const bssToken = extractCookie(request, BSS_COOKIE);

  if (requiresOperatorAuth(pathname) && bssToken === null) {
    return unauthorizedResponse();
  }

  const url = new URL(request.url);
  const backendUrl = `${env.BACKEND_ORIGIN}${url.pathname}${url.search}`;

  // Operator routes carry the session token as Bearer; public routes carry none.
  const bearer = requiresOperatorAuth(pathname) ? bssToken : null;
  return forwardToBackend(request, backendUrl, secret, bearer);
};
