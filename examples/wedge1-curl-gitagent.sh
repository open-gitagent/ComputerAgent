#!/usr/bin/env bash
#
# Wedge 1 demo against the gitagent engine (gitclaw, open-gitagent/gitagent).
# Streams every gitclaw GCMessage + ComputerAgent framing event back as SSE.
#
# Prereqs:
#   1. The harness server is running:
#        OPENAI_API_KEY=sk-... bun run examples/wedge1-server.ts
#   2. OPENAI_API_KEY is exported in this shell too (gitclaw reads process.env).
#
# Usage:
#   bash examples/wedge1-curl-gitagent.sh [optional path to a local GAP repo]

set -euo pipefail

HOST="${HARNESS_HOST:-http://127.0.0.1:7700}"
GAP_PATH="${1:-${GAP_PATH:-}}"
MODEL="${MODEL:-openai:gpt-4o-mini}"

if [[ -z "${OPENAI_API_KEY:-}" ]]; then
  echo "OPENAI_API_KEY is not set" >&2
  exit 1
fi

if [[ -z "${GAP_PATH}" ]]; then
  IDENTITY_SOURCE='{"type":"git","url":"github.com/open-gitagent/gitagent-protocol","subdir":"examples/standard"}'
else
  IDENTITY_SOURCE=$(printf '{"type":"local","path":%s}' "$(printf '%s' "${GAP_PATH}" | jq -R .)")
fi

BODY=$(jq -n --arg key "${OPENAI_API_KEY}" --arg model "${MODEL}" --argjson src "${IDENTITY_SOURCE}" '
{
  engine: "gitagent",
  identity: { loader: "gitagentprotocol", source: $src },
  envs:    { OPENAI_API_KEY: $key },
  messages: [{ role: "user", content: "Say hello and tell me your name in one short sentence." }],
  options: { model: $model, maxTurns: 3 }
}')

echo "POST ${HOST}/v1/chat  (engine=gitagent, model=${MODEL})"
echo "----- streaming response -----"

curl -sN -X POST "${HOST}/v1/chat" \
  -H "Content-Type: application/json" \
  -H "Accept: text/event-stream" \
  -d "${BODY}"
