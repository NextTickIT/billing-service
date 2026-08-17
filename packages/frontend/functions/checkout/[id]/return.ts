// WayForPay redirects the customer back to `returnUrl` with an HTTP POST (the
// transaction result is in the body). Cloudflare Pages serves the SPA as a static
// asset and answers 405 to a POST, which stranded the customer on a "page isn't
// working" error. Convert the POST into a plain GET (303) to the same path so the
// SPA return page loads; it reads the authoritative status by polling the backend
// (fed by the provider's serviceUrl callback), so the POSTed body is not needed
// here. Only POST is handled — GET falls through to the static SPA unchanged.
interface EventContext {
  request: Request;
}

type PagesFunction = (context: EventContext) => Response;

export const onRequestPost: PagesFunction = ({ request }) => {
  const url = new URL(request.url);
  return new Response(null, {
    status: 303,
    headers: { Location: `${url.pathname}${url.search}` },
  });
};
