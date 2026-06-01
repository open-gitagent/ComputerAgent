# EKS Migration Reference Manifests

Reference Kubernetes resources for migrating off ClickHouse → New Relic and off MongoDB → AWS DocumentDB. These are templates — copy into your deployment repo and adjust namespace, image refs, and resource limits to match your environment.

The actual cut-over follows the [migration plan](../../../../.claude/plans/hey-come-up-with-misty-koala.md). High level:

1. **Workstream A** — Stand up DocumentDB and roll services with the new connection string. No code changes.
2. **Workstream B** — Update the otel-collector configmap to dual-export to New Relic + ClickHouse. No service changes.
3. **Workstream C** — Roll out the Control Plane behind `TRACE_BACKEND=clickhouse|newrelic` feature flag; flip after dual-export is validated.

## Files

- [docdb-ca.configmap.yaml](docdb-ca.configmap.yaml) — AWS RDS combined CA bundle as a ConfigMap. Mount into pods that talk to DocumentDB.
- [newrelic-secrets.yaml](newrelic-secrets.yaml) — Two Secrets: the ingest license key for the collector, and the User API Key for the Control Plane.
- [otel-collector-deployment.patch.yaml](otel-collector-deployment.patch.yaml) — Strategic merge patch adding the New Relic env vars to the collector Deployment.
- [computeragent-server-deployment.patch.yaml](computeragent-server-deployment.patch.yaml) — Strategic merge patch swapping `MONGO_URL` to DocumentDB + mounting the CA bundle.
- [agentos-server-deployment.patch.yaml](agentos-server-deployment.patch.yaml) — Same Mongo patch, plus the `NEW_RELIC_*` env vars, plus the `TRACE_BACKEND` feature flag.

## Secret material — how to populate

Use [external-secrets](https://external-secrets.io/) / sealed-secrets / SOPS or whatever your team uses. The raw `Secret` manifests in this directory are for shape reference only and contain placeholders, not real values.

| Key | Source | Used by |
|---|---|---|
| `newrelic-otlp.license-key` | New Relic UI → API keys → **Ingest - License** | otel-collector |
| `newrelic-api.user-api-key` | New Relic UI → API keys → **User** (read-only role) | agentos-server (Control Plane) |
| `docdb-credentials.MONGO_URL` | Your DocumentDB master credentials, formatted per [the connection string template](#docdb-connection-string-template) | computeragent-server + agentos-server |

### DocumentDB connection string template

```
mongodb://<user>:<pass>@<cluster>.cluster-<hash>.<region>.docdb.amazonaws.com:27017/<database>?tls=true&tlsCAFile=/etc/ssl/docdb/global-bundle.pem&replicaSet=rs0&readPreference=secondaryPreferred&retryWrites=false
```

The `retryWrites=false` is required — DocumentDB does not support `retryWrites=true`.

## Validation checklist

After applying each step, verify:

**After Workstream A (DocumentDB):**
- [ ] CAS pod logs: no `MongoServerSelectionError`.
- [ ] `mongosh "$MONGO_URL"` from a pod connects (uses the mounted CA bundle).
- [ ] AgentOS dashboard `/agentos/api/agents` lists agents.
- [ ] Create a schedule via UI → row appears in `agent_schedules` collection.

**After Workstream B (dual-export):**
- [ ] otel-collector logs: both `clickhouse` and `otlp/newrelic` exporters report 200s.
- [ ] New Relic UI: **APM & Services → computeragent-server** has incoming spans.
- [ ] New Relic UI: **AI Monitoring → AI Responses** shows recent agent runs.
- [ ] Pick a `gen_ai.conversation.id` from ClickHouse → confirm same `trace.id` is in New Relic.

**After Workstream C (Control Plane flipped to NRQL):**
- [ ] `GET /v1/dashboard?from=...&to=...` returns same shape (numerically close) against both backends.
- [ ] `GET /v1/traces` list, `GET /v1/traces/:id` detail render in the AgentOS UI.
- [ ] `GET /v1/fields/:name/values` autocomplete works for `agent`, `model`, `tool`, `service`.

**Full cut-over (after 1 week of dual operation):**
- [ ] Drop `clickhouse` from `exporters: [...]` in every pipeline.
- [ ] Restart collector → tail logs → only `otlp/newrelic` reporting.
- [ ] Flip `TRACE_BACKEND` default to `newrelic`.
- [ ] Decommission ClickHouse statefulset + PVC.
