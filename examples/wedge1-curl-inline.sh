#!/usr/bin/env bash
#
# Wedge 1 demo against the claude-agent-sdk engine using an INLINE GAP repo
# (no external clone). Suitable for first-run smoke tests in restricted environments.
#
# Prereqs:
#   1. The harness server is running:
#        ANTHROPIC_API_KEY=sk-... bun run examples/wedge1-server.ts
#   2. ANTHROPIC_API_KEY is exported in this shell too.

set -euo pipefail

HOST="${HARNESS_HOST:-http://127.0.0.1:7700}"

if [[ -z "${ANTHROPIC_API_KEY:-}" ]]; then
  echo "ANTHROPIC_API_KEY is not set" >&2
  exit 1
fi

# Inline GAP repo: just agent.yaml + SOUL.md. No filesystem clone needed.
read -r -d '' AGENT_YAML <<'YAML' || true
spec_version: "0.1.0"
name: wedge1-greeter
version: 0.1.0
description: A minimal greeter agent for Wedge 1 smoke testing
model:
  preferred: claude-sonnet-4-5-20250929
runtime:
  max_turns: 2
YAML

read -r -d '' SOUL_MD <<'MD' || true
# Soul

I am a minimal greeting agent built to verify ComputerAgent's Wedge 1 plumbing.
I respond in one short sentence.
MD

BODY=$(jq -n \
  --arg key "${ANTHROPIC_API_KEY}" \
  --arg yaml "${AGENT_YAML}" \
  --arg soul "${SOUL_MD}" '
{
  engine: "claude-agent-sdk",
  identity: {
    loader: "gitagentprotocol",
    source: {
      type: "inline",
      manifest: { name: "wedge1-greeter", version: "0.1.0" },
      files: {
        "agent.yaml": $yaml,
        "SOUL.md":    $soul
      }
    }
  },
  envs:    { ANTHROPIC_API_KEY: $key },
  messages: [{ role: "user", content: "Say hello and tell me your name in one short sentence." }],
  options:  { maxTurns: 2 }
}')

echo "POST ${HOST}/v1/chat   (engine=claude-agent-sdk, source=inline)"
echo "----- streaming response -----"

curl -sN -X POST "${HOST}/v1/chat" \
  -H "Content-Type: application/json" \
  -H "Accept: text/event-stream" \
  -d "${BODY}"
