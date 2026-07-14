/** The public checkout page path for a session id (the CRM prepends the host). */
export const checkoutPath = (sessionId: string): string =>
  `/checkout/${sessionId}`;
