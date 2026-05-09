#!/usr/bin/env bash
#
# Wedge 1 demo #2 — agent writes an artifact, then we inspect the workspace via
# the harness server's filesystem API.
#
# This is the demo that sells the standard: the agent doesn't just stream tokens,
# it produces *files*, and those files are addressable through the same HTTP API
# that streamed the events.
#
# Prereqs:
#   1. Server running:
#        ANTHROPIC_API_KEY=sk-... bun run examples/wedge1-server.ts
#   2. ANTHROPIC_API_KEY exported here too.

set -euo pipefail

HOST="${HARNESS_HOST:-http://127.0.0.1:7700}"

if [[ -z "${ANTHROPIC_API_KEY:-}" ]]; then
  echo "ANTHROPIC_API_KEY is not set" >&2
  exit 1
fi

read -r -d '' AGENT_YAML <<'YAML' || true
spec_version: "0.1.0"
name: wedge1-writer
version: 0.1.0
description: An agent that writes a small artifact to its workdir
model:
  preferred: claude-sonnet-4-5-20250929
runtime:
  max_turns: 6
YAML

read -r -d '' SOUL_MD <<'MD' || true
# Soul

I am a minimal coding agent for Wedge 1's filesystem-API demo.

When asked to produce a file, I:
- Use the Write tool to create the file in the current working directory.
- Keep outputs short (a few lines).
- Do not ask for confirmation.
MD

CREATE_BODY=$(jq -n \
  --arg key "${ANTHROPIC_API_KEY}" \
  --arg yaml "${AGENT_YAML}" \
  --arg soul "${SOUL_MD}" '
{
  engine: "claude-agent-sdk",
  identity: {
    loader: "gitagentprotocol",
    source: {
      type: "inline",
      manifest: { name: "wedge1-writer", version: "0.1.0" },
      files: { "agent.yaml": $yaml, "SOUL.md": $soul }
    }
  },
  envs: { ANTHROPIC_API_KEY: $key },
  options: {
    permissionMode: "bypassPermissions",
    settingSources: ["project"]
  }
}')

echo "1) POST /v1/sessions   (create session, no run yet)"
SESSION=$(curl -s -X POST "${HOST}/v1/sessions" \
  -H "Content-Type: application/json" \
  -d "${CREATE_BODY}")
SESSION_ID=$(echo "${SESSION}" | jq -r .sessionId)
echo "   sessionId = ${SESSION_ID}"
echo

PROMPT='Create a file named hello.md containing exactly:

# Hello from ComputerAgent

This file was written by the wedge1-writer agent.

Then respond with just "done".'

MSG_BODY=$(jq -n --arg p "${PROMPT}" '{ message: { role: "user", content: $p } }')

echo "2) POST /v1/sessions/${SESSION_ID}/messages   (push a user message)"
curl -s -X POST "${HOST}/v1/sessions/${SESSION_ID}/messages" \
  -H "Content-Type: application/json" \
  -d "${MSG_BODY}" | jq .
echo

echo "3) GET /v1/sessions/${SESSION_ID}/events   (stream until done)"
# Tolerate curl exit codes (Bun's SSE close currently doesn't send a clean
# chunked terminator, which makes curl exit 18 even on a normal completion).
{ curl -sN "${HOST}/v1/sessions/${SESSION_ID}/events" || true; } | while IFS= read -r line; do
  if [[ "$line" == data:* ]]; then
    json="${line#data: }"
    kind=$(echo "$json" | jq -r .kind 2>/dev/null || echo "")
    case "$kind" in
      ca_session_started) echo "   [start]" ;;
      ca_session_ended)
        echo "   [end] $(echo "$json" | jq -r '.reason')"
        break
        ;;
      sdk_message)
        type=$(echo "$json" | jq -r '.payload.type // empty')
        if [[ "$type" == "result" ]]; then
          echo "   [result] $(echo "$json" | jq -r '.payload.result' | tr '\n' ' ' | head -c 80)"
        fi
        ;;
    esac
  fi
done || true
echo

echo "4) GET /v1/sessions/${SESSION_ID}/fs/tree   (what did the agent leave behind?)"
curl -s "${HOST}/v1/sessions/${SESSION_ID}/fs/tree?depth=1" | jq '.entries[] | {path, type, size}'
echo

echo "5) GET /v1/sessions/${SESSION_ID}/fs/file?path=hello.md   (download the artifact)"
echo "----- begin file -----"
curl -s "${HOST}/v1/sessions/${SESSION_ID}/fs/file?path=hello.md"
echo
echo "----- end file -----"
echo

echo "6) DELETE /v1/sessions/${SESSION_ID}   (cleanup)"
curl -s -X DELETE "${HOST}/v1/sessions/${SESSION_ID}" | jq .
