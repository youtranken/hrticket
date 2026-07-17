# ─── Build stage ──────────────────────────────────────────
FROM node:24-slim AS build
RUN corepack enable
WORKDIR /repo

# Workspace manifests + lockfile first (better layer caching).
# ALL workspace manifests must be present, even apps/web which this image does not
# build: --frozen-lockfile validates the lockfile against every importer declared in
# pnpm-workspace.yaml, so a missing manifest fails the check. --filter then installs
# only @hris/api and what it depends on, so web's deps are never fetched.
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile --filter @hris/api...

# Sources
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/api apps/api

RUN pnpm --filter @hris/shared build && pnpm --filter @hris/api build
RUN pnpm --filter @hris/api --prod deploy /app

# ─── Runtime stage ────────────────────────────────────────
FROM node:24-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /repo/apps/api/dist ./dist
COPY --from=build /repo/packages/shared/dist ./node_modules/@hris/shared/dist
EXPOSE 3000
CMD ["node", "dist/main.js"]
