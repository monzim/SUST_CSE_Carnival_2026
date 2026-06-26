# syntax=docker/dockerfile:1

# ---------- builder ----------
# Installs the full workspace, compiles TypeScript, then produces a pruned,
# production-only bundle for the API via `pnpm deploy`.
FROM node:22-slim AS builder
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
WORKDIR /repo

# Copy manifests first so the dependency layer caches across source-only changes.
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/core/package.json packages/core/package.json
COPY apps/api/package.json apps/api/package.json
COPY apps/cli/package.json apps/cli/package.json
RUN pnpm install --frozen-lockfile

# Build all workspace packages, then carve out a minimal prod bundle for the API.
COPY . .
RUN pnpm -r build
RUN pnpm --filter @queuestorm/api deploy --prod --legacy /app

# ---------- runner ----------
FROM node:22-slim AS runner
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
WORKDIR /app
COPY --from=builder /app /app
EXPOSE 3000
USER node
CMD ["node", "dist/index.js"]
