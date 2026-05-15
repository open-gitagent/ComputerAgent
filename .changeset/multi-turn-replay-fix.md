---
"@computeragent/sdk": patch
---

Fix multi-turn `agent.chat()` replaying first-turn events (issue #2).

Sequential `agent.chat()` calls on the same agent now produce distinct
responses. Previously the second `chat()` would re-yield the first turn's
events from the SSE replay buffer, so every turn returned the same answer.

The fix:
- Sessions are always created in streaming-input mode internally so the
  engine stays alive across turns
- Every `chat()` pushes via `/messages` (never via the createSession body)
- `/events` is opened with `Last-Event-ID: <highest seen>` so the replay
  buffer skips events the SDK already saw
- Each chat handle's iterable terminates on the turn's `result` SDK message
  (synthesizing a `ca_session_ended` for `ChatHandle.drain()`)
- `dispose()` POSTs `/end-input` so the engine drains cleanly

`consumeSseEvents` now yields `{ id?, event }` envelopes instead of bare
events — the only in-package caller (`ComputerAgent.openTurnEventStream`)
uses the id for `Last-Event-ID` tracking. Other consumers were not affected
because the function was internal.
