import { buildApp } from '@/app.js';

const app = await buildApp();

try {
  await app.listen({ host: app.appConfig.host, port: app.appConfig.port });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
