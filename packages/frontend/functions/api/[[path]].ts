interface Env {
  BACKEND_ORIGIN: string;
  BACKEND_SECRET: string;
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

function extractCookie(request: Request, name: string): string | null {
  const header = request.headers.get('cookie') ?? '';
  const match = new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(header);
  return match?.[1] ?? null;
}

function requiresOperatorAuth(pathname: string): boolean {
  return (
    pathname.startsWith('/api/payment') ||
    pathname.startsWith('/api/quarantine') ||
    pathname.startsWith('/api/support')
  );
}

function buildBackendHeaders(
  original: Headers,
  secret: string,
  token: string | null,
): Headers {
  const headers = new Headers(original);
  headers.set('X-Backend-Secret', secret);
  if (token !== null) headers.set('X-Operator-Token', token);
  return headers;
}

async function forwardToBackend(
  request: Request,
  origin: string,
  headers: Headers,
): Promise<Response> {
  const url = new URL(request.url);
  const backendUrl = `${origin}${url.pathname}${url.search}`;
  return fetch(backendUrl, {
    method: request.method,
    headers,
    body: request.body,
  });
}

function unauthorizedResponse(): Response {
  return new Response(JSON.stringify({ error: 'Unauthorized' }), {
    status: 401,
    headers: { 'Content-Type': 'application/json' },
  });
}

export const onRequest: PagesFunction<Env> = async (context) => {
  const { request, env } = context;
  const pathname = new URL(request.url).pathname;
  const token = extractCookie(request, 'bss');

  if (requiresOperatorAuth(pathname) && token === null) {
    return unauthorizedResponse();
  }

  const headers = buildBackendHeaders(request.headers, env.BACKEND_SECRET, token);
  return forwardToBackend(request, env.BACKEND_ORIGIN, headers);
};
