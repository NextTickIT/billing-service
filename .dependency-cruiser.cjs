const BACKEND = '^packages/backend/src';
const MODULES = `${BACKEND}/modules`;
const TEST_FILES = ['(^|/)test/', '\\.test\\.ts$', '\\.e2e\\.ts$'];

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment:
        'A cycle makes initialisation order and layering ambiguous; Effect layers must compose as a DAG (CLAUDE.md §2).',
      from: {},
      to: { circular: true },
    },
    {
      name: 'no-src-into-tests',
      severity: 'error',
      comment:
        'Test files never ship and src carries no test-only code (CLAUDE.md §3.4, §3.5).',
      from: { path: BACKEND, pathNot: TEST_FILES },
      to: { path: TEST_FILES },
    },
    {
      name: 'modules-not-into-boot',
      severity: 'error',
      comment:
        'Modules are composed by the runtime root, never the reverse; importing boot code drags the whole app into a unit (CLAUDE.md §2, §3.11).',
      from: { path: `${MODULES}/`, pathNot: TEST_FILES },
      to: {
        path: [
          `${BACKEND}/(app|main|runtime|worker|worker-boot|db-migrate)\\.ts$`,
          `${BACKEND}/plugins/`,
        ],
      },
    },
    {
      name: 'data-access-not-into-routes',
      severity: 'error',
      comment:
        'Transport sits on top of persistence; HTTP decoding and status codes stay in routes (CLAUDE.md §3.2).',
      from: { path: `${MODULES}/[^/]+/data-access\\.ts$` },
      to: { path: `${MODULES}/[^/]+/routes\\.ts$` },
    },
    {
      name: 'domain-not-into-routes',
      severity: 'error',
      comment:
        'Domain code takes domain commands, never transport types (CLAUDE.md §3.2).',
      from: { path: `${MODULES}/[^/]+/domain\\.ts$` },
      to: { path: `${MODULES}/[^/]+/routes\\.ts$` },
    },
    {
      name: 'domain-not-into-transport',
      severity: 'error',
      comment:
        'A domain or persistence function that takes a FastifyRequest has smuggled transport in without importing routes.ts (CLAUDE.md §3.2).',
      from: { path: `${MODULES}/[^/]+/(domain|data-access)\\.ts$` },
      to: { path: '^node_modules/(fastify|@fastify)/' },
    },
    {
      name: 'data-access-not-into-domain',
      severity: 'error',
      comment:
        'Persistence depends on schemas, not on domain logic; domain composes data-access, not the reverse (CLAUDE.md §3, docs/16).',
      from: { path: `${MODULES}/[^/]+/data-access\\.ts$` },
      to: { path: `${MODULES}/[^/]+/domain\\.ts$` },
    },
    {
      name: 'infra-not-into-modules',
      severity: 'error',
      comment:
        'infra/ is the shared home every module builds on; reaching back into a module inverts the layering (CLAUDE.md §3.13).',
      from: { path: `${BACKEND}/infra/`, pathNot: TEST_FILES },
      to: { path: `${MODULES}/` },
    },
    {
      name: 'no-orphans',
      severity: 'warn',
      comment:
        'An unreferenced file is dead code; autoloaded routes/plugins, migrations and entry points are loaded by path (CLAUDE.md §2).',
      from: {
        orphan: true,
        pathNot: [
          '(^|/)routes\\.ts$',
          '\\.plugin\\.ts$',
          `${BACKEND}/migrations/`,
          `${BACKEND}/(main|worker|db-migrate)\\.ts$`,
          '\\.d\\.ts$',
          ...TEST_FILES,
        ],
      },
      to: {},
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    // node_modules is not followed, but its edges are kept so a rule can name
    // an external package (domain-not-into-transport needs the fastify edge).
    exclude: { path: ['(^|/)dist/'] },
    tsPreCompilationDeps: true,
    // depcruise anchors tsconfig `paths` at the cwd (the repo root), so this
    // root-level tsconfig re-roots the backend's `@/*` alias for it.
    tsConfig: { fileName: 'tsconfig.depcruise.json' },
  },
};
