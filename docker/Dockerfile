FROM node:24-bookworm-slim AS base
# corepack в Node 24 не запускает pnpm 12 (ищет bin/pnpm.cjs), поэтому ставим pnpm через npm
RUN npm i -g pnpm@12.6.0
WORKDIR /app

FROM base AS deps
# pnpm-workspace.yaml carries allowBuilds (esbuild's postinstall script, needed by vite/vitest);
# pnpm 12's default supply-chain policy blocks that script's postinstall without it (ERR_PNPM_IGNORED_BUILDS).
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
RUN pnpm build

FROM base AS prod-deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod

FROM node:24-bookworm-slim AS runtime
ARG GIT_SHA=dev
ENV NODE_ENV=production GIT_SHA=$GIT_SHA
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY prompts ./prompts
# src/db/migrate.ts's default migrations folder is computed from import.meta.url, i.e. relative to the
# *compiled* dist/src/db/migrate.js at runtime — so migrations must live at dist/src/db/migrations here,
# not src/db/migrations (mirroring tsc's rootDir-preserving output layout), or runMigrations() can't find them.
COPY src/db/migrations ./dist/src/db/migrations
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/src/index.js"]
