# AGENTS.md — Dockerising the ComputerAgent stack

Reference for any agent or engineer building Docker images for the three-process stack: Computer Agent Server (CAS), AgentOS server, and AgentOS UI. Follow it verbatim — the build contexts, hostnames, and env-var split are load-bearing.

## Stack overview

Three images, two repos, one network.

| Image | Repo | Dockerfile | Base | Listens | What it does |
|---|---|---|---|---|---|
| **computeragent-server** (CAS) | `enterprise-computeragent` | [deploy/Dockerfile](../enterprise-computeragent/deploy/Dockerfile) | `node:22-bookworm-slim` (glibc + bubblewrap) | `:9100` | Hono harness — runs agents in sandboxes, owns `/sandboxes`, `/run`, `/tasks`. |
| **agentos-server** | `ComputerAgent` | [packages/agentos-server/Dockerfile](packages/agentos-server/Dockerfile) | `node:22-alpine` | `:8788` | Express control plane — dashboard API + observability read API (`/agentos/api/*`, `/v1/*`). Talks to CAS via `CA_BASE`, to Mongo for registry, to ClickHouse OR New Relic for traces. |
| **agentos-spa** (UI) | `ComputerAgent` | [agentos/Dockerfile](agentos/Dockerfile) | `nginx:1.27-alpine` | `:80` | Vite SPA + nginx reverse proxy. Proxies `/api/*` → `agentos:8788/agentos/api/*` and `/obs-api/*` → `agentos:8788/*`. |

Runtime topology when all three are running on a shared Docker network:

```
browser  ──►  agentos-spa:80  ──nginx proxy──►  agentos:8788  ──CA_BASE──►  computeragent-server:9100
                                                  │
                                                  ├──►  mongo:27017
                                                  └──►  NerdGraph (https://api.newrelic.com/graphql)
```

CAS independently pushes OTLP/HTTP traces to `OTEL_EXPORTER_OTLP_ENDPOINT` (either a local otel-collector or directly to `https://otlp.nr-data.net`).

## Build matrix — gotchas

- **CAS Dockerfile `git clone`s from GitHub during build.** It does NOT use your local source. To bake in local edits you must either (a) push your branch and pass `--build-arg GIT_BRANCH=<branch>`, or (b) use the local-source variant in the section below.
- **AgentOS server build context must be the repo root**, not the package dir — it copies workspace files (`pnpm-workspace.yaml`, `packages/protocol/`).
- **AgentOS UI's nginx config hardcodes upstream as `agentos:8788`.** The control plane container must be reachable as the hostname `agentos`. In `docker run` give it `--name agentos`; in compose name the service `agentos`; in k8s the Service is already named `agentos`.
- **`VITE_*` env vars are build-time-only.** Changing them requires rebuilding + repushing the UI image. All other env vars are runtime.

## 1. Build CAS

### From GitHub (the default Dockerfile)

```bash
cd /Users/abhisheklyzr/Desktop/lyzr-experiments/enterprise-computeragent
docker build -t computeragent-server:latest deploy/

# Override branch:
docker build \
  --build-arg REPO_URL=https://github.com/open-gitagent/ComputerAgent.git \
  --build-arg GIT_BRANCH=feat/agentos-server-dockerized \
  -t computeragent-server:latest deploy/
```

### From local source (use when iterating on uncommitted changes)

Create a Dockerfile that copies the current working tree instead of cloning. Place it at the **repo root** of ComputerAgent:

```dockerfile
# /Users/abhisheklyzr/Desktop/lyzr-experiments/ComputerAgent/Dockerfile.local-cas
FROM node:22-bookworm-slim AS builder
RUN apt-get update && apt-get install -y --no-install-recommends \
    git ca-certificates python3 build-essential && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@9.4.0 --activate
WORKDIR /src
COPY . .
RUN pnpm install --frozen-lockfile=false && pnpm -r build

FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    git ca-certificates tini bubblewrap python3 && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@9.4.0 --activate
RUN groupadd -r app && useradd -r -g app -u 10001 -m -d /home/app app
WORKDIR /app
COPY --from=builder --chown=app:app /src /app
USER app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=9100
EXPOSE 9100
WORKDIR /app/examples
ENTRYPOINT ["tini", "--", "node", "--experimental-strip-types", "--no-warnings", "computeragent-server.ts"]
```

Build:

```bash
cd /Users/abhisheklyzr/Desktop/lyzr-experiments/ComputerAgent
docker build -f Dockerfile.local-cas -t computeragent-server:local .
```

## 2. Build AgentOS server

```bash
cd /Users/abhisheklyzr/Desktop/lyzr-experiments/ComputerAgent
# -f points at the Dockerfile; context MUST be the repo root.
docker build -f packages/agentos-server/Dockerfile -t agentos-server:local .
```

## 3. Build AgentOS UI

```bash
cd /Users/abhisheklyzr/Desktop/lyzr-experiments/ComputerAgent
docker build -f agentos/Dockerfile -t agentos-ui:local .

# With custom build-time defaults (shown in the Register Agent form):
docker build -f agentos/Dockerfile \
  --build-arg VITE_AGENTOS_DEFAULT_HARNESS=claude-agent-sdk \
  --build-arg VITE_AGENTOS_DEFAULT_SOURCE=github.com/your-org/your-agent \
  --build-arg VITE_AGENTOS_DEFAULT_MODEL=claude-sonnet-4-6 \
  -t agentos-ui:local .
```

## Runtime env vars

What each image reads at runtime. Build-time-only vars are flagged.

### CAS

| Var | Required | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | yes (for claude engine) | Direct Anthropic auth. |
| `HOST`, `PORT` | optional (default `0.0.0.0:9100` in image) | Bind. |
| `MONGO_URL`, `MONGO_DATABASE` | optional | Session/task store. If unset, CAS uses in-memory fallbacks. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | optional | If set, OTel pipeline boots. Use `https://otlp.nr-data.net` for direct NR push. |
| `OTEL_EXPORTER_OTLP_HEADERS` | required if endpoint is NR | `api-key=<INGEST_LICENSE_KEY>`. |
| `OTEL_SERVICE_NAME` | optional | Default `computeragent-server`. |
| `API_AUTH_USER`, `API_AUTH_PASS` | optional | Basic auth gate for `/sandboxes`, `/run`, `/tasks`. |
| `DEFAULT_RUNTIME` | optional | `local` (default), `bwrap`, `e2b`, `vzvm`. |
| `LYZR_UPSTREAM_*` | optional | Lyzr proxy for the gitagent engine. |

### AgentOS server

| Var | Required | Purpose |
|---|---|---|
| `AGENTOS_PORT` | optional (default `8788`) | Bind. Use this — NOT `PORT` (CAS uses `PORT`). |
| `CA_BASE` | yes | Where to find CAS. In Docker network: `http://computeragent-server:9100`. |
| `MONGO_URL`, `MONGO_DATABASE` | yes | Registry, logs, sessions, schedules, chat pins. |
| `TRACE_BACKEND` | optional (default `clickhouse`) | `clickhouse` or `newrelic`. |
| `CLICKHOUSE_URL`, `CLICKHOUSE_USER`, `CLICKHOUSE_PASSWORD`, `CLICKHOUSE_DATABASE` | required if `TRACE_BACKEND=clickhouse` | |
| `NEW_RELIC_USER_API_KEY`, `NEW_RELIC_ACCOUNT_ID`, `NEW_RELIC_REGION` | required if `TRACE_BACKEND=newrelic` | NerdGraph read. Account ID is a numeric short integer, not a hex blob. |
| `API_AUTH_USER`, `API_AUTH_PASS` | optional | Basic-auth fallback when no cookie session. |
| `CORS_ORIGIN` | optional | CSV of allowed origins. Default: same-origin only. |

### AgentOS UI

| Var | Type | Purpose |
|---|---|---|
| `VITE_AGENTOS_DEFAULT_HARNESS` | **build-time** | Default harness in the Register Agent form. |
| `VITE_AGENTOS_DEFAULT_SOURCE` | **build-time** | Default source repo. |
| `VITE_AGENTOS_DEFAULT_MODEL` | **build-time** | Default model. |

Nothing at runtime. The nginx upstream is hardcoded in [agentos/nginx.conf](agentos/nginx.conf).

## Local smoke test — all three on one Docker network

```bash
docker network create agentos-net

# Mongo
docker run -d --name mongo --network agentos-net -p 27017:27017 mongo:7

# CAS
docker run -d --name computeragent-server --network agentos-net -p 9100:9100 \
  -e ANTHROPIC_API_KEY=sk-ant-... \
  -e MONGO_URL=mongodb://mongo:27017 \
  -e MONGO_DATABASE=computeragent-test \
  -e OTEL_EXPORTER_OTLP_ENDPOINT=https://otlp.nr-data.net \
  -e OTEL_EXPORTER_OTLP_HEADERS='api-key=<NEW_RELIC_LICENSE_KEY>' \
  -e OTEL_SERVICE_NAME=computeragent-server \
  -e API_AUTH_USER=clawagent \
  -e API_AUTH_PASS=51288375 \
  computeragent-server:local

# Control plane — MUST be named "agentos" so the UI's nginx upstream resolves.
docker run -d --name agentos --network agentos-net -p 8788:8788 \
  -e MONGO_URL=mongodb://mongo:27017 \
  -e MONGO_DATABASE=computeragent-test \
  -e CA_BASE=http://computeragent-server:9100 \
  -e TRACE_BACKEND=newrelic \
  -e NEW_RELIC_USER_API_KEY=NRAK-... \
  -e NEW_RELIC_ACCOUNT_ID=8123390 \
  -e NEW_RELIC_REGION=US \
  -e API_AUTH_USER=clawagent \
  -e API_AUTH_PASS=51288375 \
  agentos-server:local

# UI
docker run -d --name agentos-ui --network agentos-net -p 8080:80 agentos-ui:local

# Verify
curl http://localhost:9100/health                    # CAS
curl http://localhost:8788/agentos/api/health        # control plane (public)
curl http://localhost:8788/v1/health                 # obs API (public)
open http://localhost:8080
```

## Push to ECR (EKS deploy path)

```bash
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
REGION=us-east-1
REGISTRY=${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com

aws ecr get-login-password --region $REGION \
  | docker login --username AWS --password-stdin $REGISTRY

# Repo names match enterprise-computeragent/deploy/eks-fullstack/terraform/ecr.tf:
#   computeragent-server, agentos-server, agentos-spa, fullstack-worker.
docker tag computeragent-server:local $REGISTRY/computeragent-server:latest
docker tag agentos-server:local       $REGISTRY/agentos-server:latest
docker tag agentos-ui:local           $REGISTRY/agentos-spa:latest

docker push $REGISTRY/computeragent-server:latest
docker push $REGISTRY/agentos-server:latest
docker push $REGISTRY/agentos-spa:latest

# Roll the pods
cd /Users/abhisheklyzr/Desktop/lyzr-experiments/enterprise-computeragent/deploy/eks-fullstack
kubectl apply -k overlay/
kubectl -n agentos rollout restart \
  deploy/computeragent-server deploy/agentos deploy/agentos-spa
```

## Common failure modes

| Symptom | Likely cause |
|---|---|
| `docker build` for agentos-server fails with `pnpm-workspace.yaml not found` | Build context isn't the repo root. Use `docker build -f packages/agentos-server/Dockerfile .` from ComputerAgent root. |
| UI loads but `/api/*` calls 502 | Control plane container isn't named `agentos`, or not on the same Docker network as the UI container. |
| CAS boots, traces don't reach NR | `(auth: headers set)` missing from CAS startup log → `OTEL_EXPORTER_OTLP_HEADERS` not picked up. Confirm env var is set on the container. |
| Control plane 500s on `/v1/dashboard` with `NRQL Syntax Error` | NRQL generator drifted from what NR accepts. Check FACET / aliasing — NR doesn't allow `FACET attr AS alias`. |
| `pnpm install` fails inside the CAS builder with native compile errors | Missing `python3 build-essential` in the builder stage. The provided Dockerfiles include both — don't strip them. |
| CAS container restarts in a loop on macOS | bubblewrap binary refusing to start; set `AGENT_SANDBOX_RUNTIME=local` to use the non-bwrap path. |

## What this guide deliberately doesn't cover

- The Temporal worker image — see [enterprise-computeragent/deploy/fullstack-base/worker/Dockerfile](../enterprise-computeragent/deploy/fullstack-base/worker/Dockerfile).
- Docker-compose orchestration — see [enterprise-computeragent/deploy/docker-compose/](../enterprise-computeragent/deploy/docker-compose/).
- Kubernetes manifests — see [enterprise-computeragent/deploy/fullstack-base/k8s/](../enterprise-computeragent/deploy/fullstack-base/k8s/) and the Kustomize overlay at [enterprise-computeragent/deploy/eks-fullstack/overlay/](../enterprise-computeragent/deploy/eks-fullstack/overlay/).
- Terraform provisioning — see [enterprise-computeragent/deploy/terraform/](../enterprise-computeragent/deploy/terraform/) and [enterprise-computeragent/deploy/eks-fullstack/terraform/](../enterprise-computeragent/deploy/eks-fullstack/terraform/).
