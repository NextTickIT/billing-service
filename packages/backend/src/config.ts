/**
 * Application configuration shape and loader.
 * Values come from the environment; the DB host defaults to the
 * project-specific loopback (see README / docker-compose).
 */
export interface DatabaseConfig {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  readonly database: string;
}

export interface AppConfig {
  readonly host: string;
  readonly port: number;
  readonly database: DatabaseConfig;
}

export const loadConfig = (): AppConfig => ({
  host: process.env['HOST'] ?? '0.0.0.0',
  port: Number(process.env['PORT'] ?? '3000'),
  database: {
    host: process.env['DB_HOST'] ?? 'billing-service.local',
    port: Number(process.env['DB_PORT'] ?? '5432'),
    user: process.env['DB_USER'] ?? 'billing',
    password: process.env['DB_PASSWORD'] ?? 'billing',
    database: process.env['DB_NAME'] ?? 'billing',
  },
});
