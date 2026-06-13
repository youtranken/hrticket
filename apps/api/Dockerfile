# ─── Build stage ──────────────────────────────────────────
FROM node:24-slim AS build
RUN corepack enable
WORKDIR /repo

# Workspace manifests first (better layer caching)
COPY pnpm-workspace.yaml package.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile=false

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
