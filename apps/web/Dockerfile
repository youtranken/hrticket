# ─── Build stage ──────────────────────────────────────────
FROM node:24-slim AS build
RUN corepack enable
WORKDIR /repo

# See apps/api/Dockerfile: every workspace manifest must be present for
# --frozen-lockfile to validate; --filter keeps the install to @hris/web's tree.
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/shared/package.json packages/shared/
COPY apps/web/package.json apps/web/
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile --filter @hris/web...

COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/web apps/web
RUN pnpm --filter @hris/shared build && pnpm --filter @hris/web build

# ─── Runtime stage (nginx) ────────────────────────────────
FROM nginx:1.27-alpine AS runtime
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
EXPOSE 80
