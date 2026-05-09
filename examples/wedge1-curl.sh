#!/usr/bin/env bash
#
# Wedge 1 demo: drive an agent end-to-end through POST /v1/chat with curl.
# Streams every SDKMessage + ComputerAgent framing event back as SSE.
#
# Prereqs:
#   1. The harness server is running:
#        ANTHROPIC_API_KEY=sk-... bun run examples/wedge1-server.ts
#   2. ANTHROPIC_API_KEY is exported in this shell too (used by the server).
#
# Usage:
#   bash examples/wedge1-curl.sh [optional path to a local GAP repo]

set -euo pipefail

HOST="${HARNESS_HOST:-http://127.0.0.1:7700}"
GAP_PATH="${1:-${GAP_PATH:-}}"

if [[ -z "${ANTHROPIC_API_KEY:-}" ]]; then
  echo "ANTHROPIC_API_KEY is not set" >&2
  exit 1
fi

# If no local GAP path provided, default to fetching the public 'examples/standard'
# from the open-gitagent/gitagent-protocol repository.
if [[ -z "${GAP_PATH}" ]]; then
  IDENTITY_SOURCE='{"type":"git","url":"github.com/open-gitagent/gitagent-protocol","subdir":"examples/standard"}'
else
  IDENTITY_SOURCE=$(printf '{"type":"local","path":%s}' "$(printf '%s' "${GAP_PATH}" | jq -R .)")
fi

BODY=$(jq -n --arg api "${ANTHROPIC_API_KEY}" --argjson src "${IDENTITY_SOURCE}" '
{
  engine: "claude-agent-sdk",
  identity: { loader: "gitagentprotocol", source: $src },
  envs:    { ANTHROPIC_API_KEY: $api },
  messages: [{ role: "user", content: "Say hello and tell me your name in one short sentence." }],
  options: { maxTurns: 3 }
}')

echo "POST ${HOST}/v1/chat   (engine=claude-agent-sdk, source=${IDENTITY_SOURCE})"
echo "----- streaming response -----"

curl -sN -X POST "${HOST}/v1/chat" \
  -H "Content-Type: application/json" \
  -H "Accept: text/event-stream" \
  -d "${BODY}"
