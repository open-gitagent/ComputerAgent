# Multi-stage build: install + tsc -b → small runtime image with dist/.
# Run from the REPO ROOT so the workspace lockfile + workspace-deps copy correctly:
#   docker build -f packages/agentos-server/Dockerfile -t agentos-server .

FROM node:22-alpine AS builder
WORKDIR /app

# pnpm via corepack — same version as packageManager in root package.json.
RUN corepack enable && corepack prepare pnpm@9.4.0 --activate

# Bring in just enough of the workspace to install + build agentos-server and
# its workspace deps (currently just @open-gitagent/protocol).
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY packages/agentos-server packages/agentos-server
COPY packages/protocol      packages/protocol

# Install all deps needed to build the agentos-server graph.
RUN pnpm install --frozen-lockfile --filter @computeragent/agentos-server...

# Build protocol first (workspace dep), then agentos-server.
RUN pnpm --filter @open-gitagent/protocol build \
 && pnpm --filter @computeragent/agentos-server build

# ── Runtime ────────────────────────────────────────────────────────────
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production

# pnpm again so we can install --prod from the built workspace.
RUN corepack enable && corepack prepare pnpm@9.4.0 --activate

# Copy lockfile + workspace manifests + built artifacts.
COPY --from=builder /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml ./
COPY --from=builder /app/packages/agentos-server/package.json packages/agentos-server/
COPY --from=builder /app/packages/agentos-server/dist        packages/agentos-server/dist
COPY --from=builder /app/packages/protocol/package.json      packages/protocol/
COPY --from=builder /app/packages/protocol/dist              packages/protocol/dist

RUN pnpm install --prod --frozen-lockfile --filter @computeragent/agentos-server...

EXPOSE 8788
WORKDIR /app/packages/agentos-server
CMD ["node", "dist/index.js"]
