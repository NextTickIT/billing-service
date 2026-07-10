import { Schema } from 'effect';

/**
 * Roles are numeric TypeScript enums, stored as numbers everywhere (db as
 * `smallint`, backend, frontend). Both auth tokens and operators carry a role;
 * an Admin-role credential is required to create tokens/operators, and a
 * session carries its operator's role. The Schema mirror validates the values.
 */
export enum Role {
  Admin = 0,
  Operator = 1,
  Service = 2,
}

export const RoleSchema = Schema.Enums(Role);
