# Backend image — one image, two entrypoints (server + worker).
# Build from the REPO ROOT so the monorepo lockfile and workspaces resolve:
#   docker build -f packages/backend/Dockerfile -t <image> .
# bookworm-slim (glibc) so argon2's prebuilt binary loads without a toolchain.

# ---- builder: install everything, build shared -> backend via turbo ----
FROM node:22-bookworm-slim AS builder
WORKDIR /app

# Manifests first for a cached dependency layer. All workspace package.json files
# must be present or `npm ci` rejects the lockfile.
COPY package.json package-lock.json turbo.json tsconfig.base.json tsconfig.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/backend/package.json packages/backend/
COPY packages/frontend/package.json packages/frontend/
RUN npm ci

# Sources (host node_modules/dist are excluded by .dockerignore, so the npm ci
# layer above is preserved). `^build` makes turbo build shared before backend.
COPY . .
RUN npx turbo run build --filter=@billing-service/backend

# ---- runner: prod-only deps + built artifacts ----
FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/backend/package.json packages/backend/
COPY packages/frontend/package.json packages/frontend/
# Recreates the workspace symlink node_modules/@billing-service/shared -> packages/shared.
RUN npm ci --omit=dev

# Compiled output only. dist/migrations/*.js are loaded at startup by infra/migrator.ts.
COPY --from=builder /app/packages/shared/dist packages/shared/dist
COPY --from=builder /app/packages/backend/dist packages/backend/dist

USER node
EXPOSE 3000
# Default = HTTP server (runs migrations at startup, then serves). The worker
# overrides this with `node packages/backend/dist/worker.js` in compose.
CMD ["node", "packages/backend/dist/main.js"]
