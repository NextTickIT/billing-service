/**
 * Generic helper mirroring the schema-level `Schema.omit('id')` computation at
 * the type level: create params = an entity without its server-owned `id`.
 * Concrete contract types (e.g. CreateSubscription) are derived from schemas.
 */
export type CreateParams<A extends { readonly id: unknown }> = Omit<A, 'id'>;
