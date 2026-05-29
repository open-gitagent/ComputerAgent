# AgentOS SPA — Vite build, nginx serves the static bundle and reverse-proxies
# /api/* + /obs-api/* to the agentos-server container.
#
# Build from the REPO ROOT:
#   docker build -f agentos/Dockerfile -t agentos-spa .
#
# Build-time defaults (VITE_AGENTOS_DEFAULT_*) get baked into the bundle —
# they show in the Register-Agent form's prefills. Override per-deployment via
# docker-compose `args:`.
#
# Note: agentos/ is a standalone Vite app, not a pnpm workspace member, so we
# install + build it without `--filter` or the repo lockfile.

# ── Build the SPA bundle ───────────────────────────────────────────────
FROM node:22-alpine AS builder
WORKDIR /src

RUN corepack enable && corepack prepare pnpm@9.4.0 --activate

# Cache deps separately from source for faster rebuilds.
COPY agentos/package.json agentos/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# Now bring in the rest of the source.
COPY agentos/ ./

# Build-time env — bundled into the JS, override via docker-compose `args:`.
ARG VITE_AGENTOS_DEFAULT_HARNESS=claude-agent-sdk
ARG VITE_AGENTOS_DEFAULT_SOURCE=github.com/shreyas-lyzr/general-agent
ARG VITE_AGENTOS_DEFAULT_MODEL=claude-sonnet-4-6
ENV VITE_AGENTOS_DEFAULT_HARNESS=$VITE_AGENTOS_DEFAULT_HARNESS \
    VITE_AGENTOS_DEFAULT_SOURCE=$VITE_AGENTOS_DEFAULT_SOURCE \
    VITE_AGENTOS_DEFAULT_MODEL=$VITE_AGENTOS_DEFAULT_MODEL

RUN pnpm build


# ── Runtime: nginx serving the bundle + reverse-proxy to agentos-server ──
FROM nginx:1.27-alpine

COPY agentos/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /src/dist /usr/share/nginx/html

EXPOSE 80
