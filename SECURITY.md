# Security policy

## Reporting a vulnerability

Please **don't** open a public issue for security reports.

Email **security@open-gitagent.dev** with:
- A description of the vulnerability
- Steps to reproduce (the smallest case you can)
- Affected versions / commits
- Your assessment of impact

We aim to acknowledge within 72 hours and ship a fix or mitigation within 14 days for critical issues. We'll credit you in the release notes unless you prefer otherwise.

## Scope

In scope:
- Path traversal, RCE, or sandbox-escape in `@computeragent/harness-server` (the workspace FS API, the path-jail, etc.)
- Authentication bypass in `AuthHandler` integrations
- SessionStore data leakage between sessions or tenants
- Substrate isolation failures (one session reaching another's filesystem / network)
- Dependency-confusion or supply-chain risks in the published packages

Out of scope (but still tell us if you care):
- DoS via malformed input (we already validate at the wire boundary)
- Issues in third-party plug-ins published by other authors
- Issues that require an attacker who already has the `ANTHROPIC_API_KEY` or other root credentials

## Hardening guidance for production

The harness server is loopback-friendly by default. For non-loopback deployments:
- Set `authHandler` (any of `bearerToken`, `sharedSecretAuth`, or your own implementation)
- Run behind a TLS terminator
- Enable `validateStoreEntries: true` if your `SessionStore` is shared with external writers
- Configure a real `auditSink` for compliance-relevant deployments

See [`CONTRIBUTING.md`](./CONTRIBUTING.md#failure-semantics) for the documented failure-isolation contract.
