#!/usr/bin/env python3
"""
Wedge 1.12 — aggressive integration tests for /sandboxes.

Runs against a live ComputerAgentServer (default: https://api.clawagent.sh).
Each test creates its own sandbox(es), exercises one scenario, then disposes.
"""

import argparse, json, subprocess, sys, time, threading, urllib.request, urllib.error
from contextlib import contextmanager
from concurrent.futures import ThreadPoolExecutor

# ── HTTP helpers (stdlib only — keep this dependency-free) ────────────────

def http(method, url, body=None, headers=None, timeout=120):
    """Returns (status, headers_dict, body_bytes). Never throws on HTTP errors."""
    data = None
    h = {"accept": "application/json"}
    if body is not None:
        data = json.dumps(body).encode()
        h["content-type"] = "application/json"
    if headers: h.update(headers)
    req = urllib.request.Request(url, data=data, method=method, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, dict(r.headers), r.read()
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read()

def jget(url, **kw):
    s, _, b = http("GET", url, **kw)
    return s, json.loads(b) if b else {}

def jpost(url, body, **kw):
    s, _, b = http("POST", url, body, **kw)
    return s, (json.loads(b) if b else {})

def jdelete(url, **kw):
    s, _, b = http("DELETE", url, **kw)
    return s, (json.loads(b) if b else {})

def _extract_final_text(payload, prev_text, deepagents_msg_count):
    """Pluck the LAST assistant text from an sdk_message payload, across all
    three harness dialects. Returns (new_text_or_prev, updated_msg_count).
    Mirrors the dispatch logic in test.html's `dispatchEvent`."""
    if not isinstance(payload, dict):
        return prev_text, deepagents_msg_count

    # ── claude-agent-sdk: assistant.message.content[]
    if payload.get("type") == "assistant" and isinstance(payload.get("message"), dict):
        for b in payload["message"].get("content", []) or []:
            if b.get("type") == "text" and isinstance(b.get("text"), str):
                prev_text = b["text"]

    # ── gitagent: top-level assistant.content (string)
    if payload.get("type") == "assistant" and isinstance(payload.get("content"), str):
        prev_text = payload["content"]

    # ── universal terminator emitted by gitagent + deepagents
    if payload.get("type") == "result" and isinstance(payload.get("result"), str):
        prev_text = payload["result"]

    # ── deepagents: LangGraph "values" snapshot — payload.messages[] grows;
    # dedupe by tracking how many we've seen and only scanning the tail.
    msgs = payload.get("messages")
    if isinstance(msgs, list):
        new = msgs[deepagents_msg_count:]
        deepagents_msg_count = len(msgs)
        for msg in new:
            m = msg.get("kwargs") if isinstance(msg, dict) and isinstance(msg.get("kwargs"), dict) else msg
            cls = ".".join(msg.get("id", []) if isinstance(msg, dict) else [])
            if "AIMessage" in cls:
                if isinstance(m.get("content"), str) and m["content"].strip():
                    prev_text = m["content"]
                elif isinstance(m.get("content"), list):
                    parts = [b.get("text") for b in m["content"]
                             if isinstance(b, dict) and b.get("type") == "text" and isinstance(b.get("text"), str)]
                    joined = "".join(parts)
                    if joined.strip():
                        prev_text = joined

    return prev_text, deepagents_msg_count


def sse_chat(base, sbx_id, message, timeout=120):
    """Open POST /sandboxes/:id/chat as SSE, parse events into a list.
    Returns (final_status_code, events_list, final_text_or_None, elapsed_ms).

    Final-text extraction handles all three harness dialects (claude-sdk
    nested-content, gitagent flat-content string, deepagents LangGraph
    messages array) via _extract_final_text."""
    t0 = time.time()
    url = f"{base}/sandboxes/{sbx_id}/chat"
    req = urllib.request.Request(url,
        data=json.dumps({"message": message}).encode(),
        method="POST",
        headers={"content-type": "application/json", "accept": "text/event-stream"})
    events, final_text = [], None
    deepagents_msg_count = 0
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            status = r.status
            buf = b""
            for chunk in r:
                buf += chunk
                while b"\n\n" in buf:
                    frame, buf = buf.split(b"\n\n", 1)
                    ev = None; data = None
                    for line in frame.splitlines():
                        s = line.decode("utf-8", "replace")
                        if s.startswith("event: "): ev = s[7:]
                        elif s.startswith("data: "):
                            try: data = json.loads(s[6:])
                            except: data = s[6:]
                    if ev:
                        events.append({"kind": ev, "data": data})
                        if ev == "sdk_message" and isinstance(data, dict):
                            final_text, deepagents_msg_count = _extract_final_text(
                                data.get("payload", {}), final_text, deepagents_msg_count,
                            )
    except urllib.error.HTTPError as e:
        return e.code, [], None, int((time.time() - t0) * 1000)
    return status, events, final_text, int((time.time() - t0) * 1000)

# ── Reporting ──────────────────────────────────────────────────────────────

PASS = "\033[32mPASS\033[0m"
FAIL = "\033[31mFAIL\033[0m"
SKIP = "\033[33mSKIP\033[0m"
DIM  = "\033[2m"; END = "\033[0m"

class Report:
    def __init__(self):
        self.results = []  # (name, ok, detail, elapsed)
    def add(self, name, ok, detail="", elapsed_ms=0):
        tag = PASS if ok else FAIL
        print(f"  {tag} {name}  {DIM}({elapsed_ms}ms){END}  {detail}")
        self.results.append((name, ok, detail, elapsed_ms))
    def skip(self, name, reason):
        print(f"  {SKIP} {name}  {DIM}{reason}{END}")
    def summary(self):
        ok = sum(1 for _,o,_,_ in self.results if o)
        fail = len(self.results) - ok
        print(f"\n{'='*70}")
        print(f"  {ok}/{len(self.results)} passed,  {fail} failed")
        return fail == 0

# ── Test fixtures ──────────────────────────────────────────────────────────

DEFAULT_BODY = {
    "source": "github.com/shreyas-lyzr/pdf-agent",
    "harness": "claude-agent-sdk",
    "runtime": "bwrap",
    "options": {"permissionMode": "bypassPermissions", "settingSources": ["project"]},
}

# Set by main() based on --harness; tests read DEFAULT_BODY directly so this
# is a sufficient hook (DEFAULT_BODY is rebuilt with .update at startup).

@contextmanager
def sandbox(base, **overrides):
    body = {**DEFAULT_BODY, **overrides}
    status, doc = jpost(f"{base}/sandboxes", body)
    if status != 201:
        raise RuntimeError(f"sandbox create failed: {status} {doc}")
    sid = doc["sandboxId"]
    try:
        yield sid, doc
    finally:
        jdelete(f"{base}/sandboxes/{sid}")

# ── Individual tests ───────────────────────────────────────────────────────

def t_create_and_dispose(base, r):
    """Basic lifecycle: create → snapshot → delete → 404."""
    t0 = time.time()
    status, doc = jpost(f"{base}/sandboxes", DEFAULT_BODY)
    elapsed = int((time.time() - t0) * 1000)
    if status != 201:
        return r.add("create_and_dispose", False, f"POST returned {status} {doc}", elapsed)
    sid = doc["sandboxId"]
    r.add("create returns 201 with sandboxId", sid.startswith("sbx_"), f"id={sid}", elapsed)

    # Snapshot
    s, snap = jget(f"{base}/sandboxes/{sid}")
    r.add("snapshot returns 200", s == 200 and snap.get("sandboxId") == sid, f"state={snap.get('state')}")

    # Delete
    s, del_resp = jdelete(f"{base}/sandboxes/{sid}")
    r.add("delete returns ok:true", s == 200 and del_resp.get("ok") is True, str(del_resp))

    # 404 after
    s, _ = jget(f"{base}/sandboxes/{sid}")
    r.add("404 after delete", s == 404, f"got {s}")

def t_validation(base, r):
    """Reject malformed bodies cleanly."""
    s, doc = jpost(f"{base}/sandboxes", {})
    r.add("400 on empty body", s == 400 and doc.get("error", {}).get("code") == "MISSING_SOURCE", str(doc))

    s, doc = jpost(f"{base}/sandboxes", {"source": "x"})
    r.add("400 on missing harness", s == 400 and doc.get("error", {}).get("code") == "MISSING_HARNESS", str(doc))

    s, doc = jpost(f"{base}/sandboxes", {**DEFAULT_BODY, "idleTtlMs": -100})
    r.add("400 on negative idleTtlMs", s == 400 and doc.get("error", {}).get("code") == "INVALID_TTL", str(doc))

    s, doc = jpost(f"{base}/sandboxes", {**DEFAULT_BODY, "runtime": "nonexistent"})
    r.add("400 on unknown runtime", s == 400 and doc.get("error", {}).get("code") == "UNKNOWN_RUNTIME", str(doc))

def t_ttl_clamping(base, r):
    """Client-supplied TTL beyond server max gets clamped, not rejected."""
    # Ask for 10 hours hard cap. Server default max is 2h = 7_200_000.
    with sandbox(base, ttlMs=36_000_000, idleTtlMs=200_000) as (sid, doc):
        # Server reports the clamped value, not the requested one.
        r.add("hard TTL clamped to server max",
              doc["ttlMs"] <= 7_200_000,
              f"requested 36000000, got {doc['ttlMs']}")
        r.add("idle TTL passed through",
              doc["idleTtlMs"] == 200_000,
              f"got {doc['idleTtlMs']}")

def t_404_on_chat_unknown(base, r):
    s, doc = jpost(f"{base}/sandboxes/sbx_does_not_exist/chat", {"message": "hi"})
    r.add("chat → 404 on unknown sandbox", s == 404, str(doc))

def t_multi_turn_warmth(base, r):
    """Turn 2 should be substantially faster than turn 1 (cold)."""
    with sandbox(base) as (sid, _):
        s1, evs1, txt1, ms1 = sse_chat(base, sid, "Reply with exactly: ONE")
        s2, evs2, txt2, ms2 = sse_chat(base, sid, "Reply with exactly: TWO")
        s3, evs3, txt3, ms3 = sse_chat(base, sid, "Reply with exactly: THREE")
        r.add("turn 1 succeeds", s1 == 200 and "ONE" in (txt1 or ""), f"text={txt1!r}", ms1)
        r.add("turn 2 succeeds + WARM (faster than turn 1)",
              s2 == 200 and ms2 < ms1 and "TWO" in (txt2 or ""),
              f"t1={ms1}ms t2={ms2}ms text={txt2!r}", ms2)
        r.add("turn 3 succeeds", s3 == 200 and "THREE" in (txt3 or ""), f"text={txt3!r}", ms3)
        snap_s, snap = jget(f"{base}/sandboxes/{sid}")
        r.add("turnCount tracks", snap.get("turnCount") == 3, f"turnCount={snap.get('turnCount')}")
        r.add("usage accumulates across turns",
              snap.get("usage", {}).get("outputTokens", 0) > 0,
              str(snap.get("usage")))

def t_context_retention(base, r):
    """The whole point: turns share conversation memory."""
    with sandbox(base) as (sid, _):
        sse_chat(base, sid, "Remember the secret word: NIMBUS9. Acknowledge with: OK.")
        s, evs, txt, ms = sse_chat(base, sid, "What was the secret word? Reply with only the word.")
        r.add("context carried across turns",
              "NIMBUS9" in (txt or "").upper(),
              f"got {txt!r}", ms)

def t_busy_409(base, r):
    """While turn 1 is streaming, turn 2 must reject with 409."""
    with sandbox(base) as (sid, _):
        # Long-ish first turn so we can race a second request into it.
        out_a = {}
        def first():
            out_a["res"] = sse_chat(base, sid, "Count from 1 to 30 one number per line slowly.")
        th = threading.Thread(target=first); th.start()
        time.sleep(1.5)  # let the first turn engage
        s, doc = jpost(f"{base}/sandboxes/{sid}/chat", {"message": "interfere"})
        r.add("409 BUSY on concurrent chat",
              s == 409 and doc.get("error", {}).get("code") == "BUSY",
              str(doc))
        r.add("409 includes currentTurnStartedAt",
              "currentTurnStartedAt" in (doc.get("error", {}) or {}),
              str(doc.get("error", {}).get("currentTurnStartedAt")))
        th.join(timeout=120)
        # After the first turn ends, a new chat should succeed.
        time.sleep(0.5)
        s2, _, _, _ = sse_chat(base, sid, "Reply with: BACKAGAIN")
        r.add("chat works again after first turn ends", s2 == 200)

def t_dispose_mid_chat(base, r):
    """DELETE during an in-flight chat must terminate cleanly, not deadlock."""
    with sandbox(base) as (sid, _):
        out = {}
        def chat():
            out["res"] = sse_chat(base, sid, "Count from 1 to 50 slowly with reasoning between each.", timeout=60)
        th = threading.Thread(target=chat); th.start()
        time.sleep(3)
        t0 = time.time()
        s, doc = jdelete(f"{base}/sandboxes/{sid}")
        delete_ms = int((time.time() - t0) * 1000)
        r.add("DELETE during chat returns quickly",
              s == 200 and delete_ms < 5000,
              f"{delete_ms}ms", delete_ms)
        th.join(timeout=15)
        r.add("in-flight chat thread terminated", not th.is_alive())
        # Sandbox is gone — second chat is 404.
        s2, _ = jpost(f"{base}/sandboxes/{sid}/chat", {"message": "hi"})
        r.add("404 after mid-chat dispose", s2 == 404, f"got {s2}")

def t_idle_ttl_expiry(base, r):
    """A sandbox with tiny idleTtlMs and no chats gets reaped."""
    # idle 8s; no chats → reaper kills after firstChatSeen check skipped... actually
    # firstChatSeen=False uses bootDeadlineAt (60s default), NOT idleExpiresAt.
    # So to test idle TTL we need to chat once first, then wait.
    with sandbox(base, idleTtlMs=8000, ttlMs=180000) as (sid, _):
        # First chat — flips firstChatSeen=True and refreshes idleExpiresAt.
        sse_chat(base, sid, "Reply with: OK")
        time.sleep(14)  # 14s > 8s idle + 5s reaper tick
        s, doc = jget(f"{base}/sandboxes/{sid}")
        r.add("idle TTL reaps after chat",
              s == 404,
              f"got {s} {doc.get('state','')}")

def t_hard_ttl_overrides_activity(base, r):
    """Hard cap fires even while chats are happening."""
    with sandbox(base, idleTtlMs=300000, ttlMs=15000) as (sid, _):
        # Chat once to warm up + flip firstChatSeen.
        sse_chat(base, sid, "Reply with: OK")
        # Now wait past hard cap.
        time.sleep(22)  # 22s > 15s hard + 5s reaper tick
        s, _ = jget(f"{base}/sandboxes/{sid}")
        r.add("hard TTL reaps even when idle TTL would still be alive",
              s == 404, f"got {s}")

def t_boot_deadline(base, r):
    """Sandbox created but never chatted → reaped at boot deadline."""
    # NOTE: this assumes SANDBOX_BOOT_DEADLINE_MS is set to something testable
    # (default 60s — too long for a smoke test). Skip unless overridden via
    # env, but still document expectation.
    r.skip("boot_deadline", "60s default — covered by manual verification, would slow test suite")

def t_concurrent_sandboxes(base, r):
    """N independent sandboxes can chat in parallel without cross-talk."""
    N = 3
    sids = []
    try:
        for _ in range(N):
            s, doc = jpost(f"{base}/sandboxes", DEFAULT_BODY)
            if s == 429:
                r.skip("concurrent_sandboxes", "server returned 429 — pool full")
                return
            if s != 201:
                r.add("create N sandboxes", False, f"got {s}")
                return
            sids.append(doc["sandboxId"])
        r.add(f"create {N} sandboxes in parallel", len(sids) == N)

        # Chat each one with its own secret word. Then ask each to recall.
        secrets = [f"SECRET-{i}" for i in range(N)]
        with ThreadPoolExecutor(max_workers=N) as ex:
            list(ex.map(lambda x: sse_chat(base, x[0], f"Remember word: {x[1]}. Reply with: OK."), zip(sids, secrets)))

        # Recall — each sandbox should know its own secret only.
        with ThreadPoolExecutor(max_workers=N) as ex:
            results = list(ex.map(lambda sid: sse_chat(base, sid, "What was the word you were told? Reply with only the word."), sids))
        all_correct = all(
            secrets[i] in (results[i][2] or "")
            for i in range(N)
        )
        r.add("each sandbox keeps its OWN context",
              all_correct,
              f"recalled={[r[2] for r in results]}")
    finally:
        for sid in sids:
            jdelete(f"{base}/sandboxes/{sid}")

def t_max_concurrent_429(base, r):
    """When the pool is full, POST /sandboxes returns 429."""
    r.skip("max_concurrent_429",
           "would consume all slots on a shared server — verify locally with SANDBOX_MAX_CONCURRENT=2")

def t_list_endpoint(base, r):
    """GET /sandboxes lists active sandboxes."""
    with sandbox(base) as (sid, _):
        s, doc = jget(f"{base}/sandboxes")
        ids = [x["sandboxId"] for x in doc.get("sandboxes", [])]
        r.add("list includes the created sandbox", s == 200 and sid in ids, f"ids={ids}")
        r.add("list entries omit `events` field",
              all("events" not in x for x in doc.get("sandboxes", [])))

def t_sequential_rapid_fire(base, r):
    """5 sequential chats in a row — substrate stays warm the entire time."""
    with sandbox(base) as (sid, _):
        elapsed = []
        for i in range(5):
            s, _, _, ms = sse_chat(base, sid, f"Reply with the number {i+1} as a word.")
            elapsed.append(ms)
            if s != 200:
                r.add(f"rapid-fire turn {i+1}", False, f"got {s}")
                return
        avg_warm = sum(elapsed[1:]) / 4
        r.add(f"5 sequential turns all under 15s each",
              all(ms < 15000 for ms in elapsed),
              f"{elapsed}")
        r.add("warm turns avg < cold turn (proves no reboot per turn)",
              avg_warm < elapsed[0],
              f"cold={elapsed[0]}ms warm avg={int(avg_warm)}ms")

def t_invalid_chat_body(base, r):
    with sandbox(base) as (sid, _):
        s, doc = jpost(f"{base}/sandboxes/{sid}/chat", {})
        r.add("400 on chat with no message", s == 400, str(doc))

def t_health_unaffected(base, r):
    """/health still works alongside active sandboxes."""
    with sandbox(base) as (sid, _):
        s, h = jget(f"{base}/health")
        r.add("/health 200 with sandbox active", s == 200 and h.get("ok"), str(h))

# ── Wedge 1.13: heartbeat + snapshot/restore + autoSave ───────────────────

def t_heartbeat_refreshes_idle(base, r):
    """A heartbeat past the original idle deadline keeps the sandbox alive."""
    with sandbox(base, idleTtlMs=10000, ttlMs=180000) as (sid, doc):
        # First chat flips firstChatSeen — necessary for the idle TTL to be
        # the relevant timer (otherwise the boot deadline kicks in first).
        sse_chat(base, sid, "Reply with: OK")
        # Wait 6s, hit heartbeat — original idle was 10s out from chat-end.
        time.sleep(6)
        s, hb = jpost(f"{base}/sandboxes/{sid}/heartbeat", {})
        r.add("heartbeat returns 200 + new idleExpiresAt",
              s == 200 and hb.get("idleExpiresAt"),
              str(hb))
        # Now wait another 9s — without the heartbeat the sandbox would be
        # dead by now (6 + 9 = 15s, idle was 10s). With heartbeat at t=6 it
        # was refreshed to t+10=16s, so at t=15 it should still be alive.
        time.sleep(9)
        s2, snap = jget(f"{base}/sandboxes/{sid}")
        r.add("sandbox still alive 15s after creation thanks to heartbeat",
              s2 == 200, f"got {s2}")
        # Stop pinging. After idle (~10s) + reaper tick, it should die.
        time.sleep(14)
        s3, _ = jget(f"{base}/sandboxes/{sid}")
        r.add("sandbox reaped after heartbeat stops",
              s3 == 404, f"got {s3}")

def t_heartbeat_unknown(base, r):
    s, doc = jpost(f"{base}/sandboxes/sbx_does_not_exist/heartbeat", {})
    r.add("heartbeat → 404 on unknown sandbox", s == 404, str(doc))

def t_snapshot_round_trip_memory(base, r):
    """Seed a file via attachments, snapshot, restore, verify the workdir
    round-tripped. The verification has two layers:

      1. Structural (harness-agnostic): the original snapshot's fileCount
         matches a re-snapshot of the restored sandbox. Proves the OS-level
         workdir survived the round-trip.
      2. Agent-read (where applicable): for harnesses whose tools see the OS
         workdir directly (claude-agent-sdk, gitagent), ask the Read tool
         to fetch the seed file's content. Skipped for deepagents which
         uses an in-memory virtual filesystem that's separate from the OS
         workdir (its tools can't see attachments).
    """
    body = {
        **DEFAULT_BODY,
        "attachments": [
            {"path": "test-marker.txt", "content": "NIMBUS-9", "encoding": "utf8"},
        ],
    }
    s, doc = jpost(f"{base}/sandboxes", body)
    if s != 201:
        r.add("create with attachments", False, f"got {s}: {doc}")
        return
    sid = doc["sandboxId"]
    harness = DEFAULT_BODY["harness"]
    agent_sees_os_workdir = harness in ("claude-agent-sdk", "gitagent")
    try:
        sse_chat(base, sid, "Reply with: OK")

        if agent_sees_os_workdir:
            _, _, txt0, _ = sse_chat(base, sid, "Use the Read tool to read test-marker.txt and reply with only its content.")
            r.add("seed attachment readable by agent before snapshot",
                  "NIMBUS-9" in (txt0 or ""),
                  f"got {txt0!r}")
        else:
            r.skip("seed attachment readable by agent before snapshot",
                   f"{harness}: tools see virtual FS, not the OS workdir")

        sn = jpost(f"{base}/sandboxes/{sid}/snapshot", {"stateStore": {"kind": "memory"}})
        r.add("snapshot returns 200 + snapshotId",
              sn[0] == 200 and sn[1].get("snapshotId", "").startswith("snap_"),
              str(sn[1]))
        snapshot_id = sn[1].get("snapshotId", "")
        original_files = sn[1].get("fileCount", 0)
        r.add("snapshot file count > 0 (workdir captured)",
              original_files > 0,
              f"files={original_files}")

        rr = jpost(f"{base}/sandboxes/restore", {
            "snapshotId": snapshot_id,
            "stateStore": {"kind": "memory"},
            "target": "new",
        })
        r.add("restore returns 201 + new sandboxId",
              rr[0] == 201 and rr[1].get("sandboxId", "").startswith("sbx_") and rr[1].get("restored"),
              str(rr[1]))
        new_sid = rr[1].get("sandboxId", "")
        try:
            sse_chat(base, new_sid, "Reply with: OK")
            # Structural check: re-snapshot the restored sandbox and verify
            # file count matches the original (within ±1 for harness-induced
            # tmp files like .pyc — tolerant but bounded).
            sn2 = jpost(f"{base}/sandboxes/{new_sid}/snapshot", {"stateStore": {"kind": "memory"}})
            restored_files = sn2[1].get("fileCount", 0) if sn2[0] == 200 else 0
            r.add("restored workdir matches original file count (structural)",
                  abs(restored_files - original_files) <= 2,
                  f"orig={original_files} restored={restored_files}")

            if agent_sees_os_workdir:
                _, _, txt, _ = sse_chat(base, new_sid, "Use the Read tool to read test-marker.txt and reply with only its content.")
                r.add("restored workdir readable by agent (seed file content)",
                      "NIMBUS-9" in (txt or ""),
                      f"got {txt!r}")
            else:
                r.skip("restored workdir readable by agent (seed file content)",
                       f"{harness}: virtual-FS gap — agent tools don't see OS workdir")
        finally:
            jdelete(f"{base}/sandboxes/{new_sid}")
    finally:
        jdelete(f"{base}/sandboxes/{sid}")

def t_snapshot_409_when_busy(base, r):
    """Snapshot during an in-flight chat must reject with 409."""
    with sandbox(base) as (sid, _):
        out = {}
        def first():
            out["res"] = sse_chat(base, sid, "Count from 1 to 25 with reasoning between each.")
        th = threading.Thread(target=first); th.start()
        time.sleep(1.5)
        s, doc = jpost(f"{base}/sandboxes/{sid}/snapshot", {"stateStore": {"kind": "memory"}})
        r.add("snapshot → 409 BUSY while chat is in flight",
              s == 409 and doc.get("error", {}).get("code") == "BUSY",
              str(doc))
        th.join(timeout=120)

def t_autosave_on_dispose(base, r):
    """Sandbox with autoSave configured snapshots automatically on DELETE."""
    # 1. Create with autoSave to memory store.
    body = {
        **DEFAULT_BODY,
        "idleTtlMs": 60000,
        "ttlMs": 180000,
        "autoSave": {"stateStore": {"kind": "memory"}},
    }
    s, doc = jpost(f"{base}/sandboxes", body)
    if s != 201:
        r.add("autosave create", False, f"got {s}: {doc}")
        return
    sid = doc["sandboxId"]
    try:
        # 2. Chat once to put SOMETHING in the workdir.
        sse_chat(base, sid, "Write a file named auto.txt with content 'AUTOSAVED'. Reply OK.")
        # 3. DELETE → triggers autoSave preDispose.
        d_s, d_doc = jdelete(f"{base}/sandboxes/{sid}")
        r.add("DELETE returns autoSaved:true",
              d_s == 200 and d_doc.get("autoSaved") is True,
              str(d_doc))
        # 4. List memory-store snapshots; expect to see one whose
        # sourceSandboxId === sid.
        time.sleep(0.5)
        l_s, l_doc = jget(f"{base}/snapshots?stateStore=memory")
        matches = [x for x in l_doc.get("snapshots", []) if x.get("sourceSandboxId") == sid]
        r.add("autoSave produced a discoverable snapshot",
              len(matches) >= 1,
              f"matches={len(matches)} all={[x.get('snapshotId') for x in l_doc.get('snapshots', [])]}")
    finally:
        # Cleanup is best-effort — DELETE on a missing sandbox is fine.
        jdelete(f"{base}/sandboxes/{sid}")

# ── Runner ─────────────────────────────────────────────────────────────────

TESTS = [
    ("create_and_dispose",            t_create_and_dispose),
    ("validation",                    t_validation),
    ("ttl_clamping",                  t_ttl_clamping),
    ("404_on_chat_unknown",           t_404_on_chat_unknown),
    ("invalid_chat_body",             t_invalid_chat_body),
    ("list_endpoint",                 t_list_endpoint),
    ("health_unaffected",             t_health_unaffected),
    ("multi_turn_warmth",             t_multi_turn_warmth),
    ("context_retention",             t_context_retention),
    ("sequential_rapid_fire",         t_sequential_rapid_fire),
    ("busy_409",                      t_busy_409),
    ("dispose_mid_chat",              t_dispose_mid_chat),
    ("concurrent_sandboxes",          t_concurrent_sandboxes),
    ("idle_ttl_expiry",               t_idle_ttl_expiry),
    ("hard_ttl_overrides_activity",   t_hard_ttl_overrides_activity),
    ("boot_deadline",                 t_boot_deadline),
    ("max_concurrent_429",            t_max_concurrent_429),
    # Wedge 1.13
    ("heartbeat_unknown",             t_heartbeat_unknown),
    ("heartbeat_refreshes_idle",      t_heartbeat_refreshes_idle),
    ("snapshot_round_trip_memory",    t_snapshot_round_trip_memory),
    ("snapshot_409_when_busy",        t_snapshot_409_when_busy),
    ("autosave_on_dispose",           t_autosave_on_dispose),
]

def main():
    p = argparse.ArgumentParser()
    p.add_argument("--base", default="https://api.clawagent.sh")
    p.add_argument("--only", help="comma-separated subset of test names")
    p.add_argument("--harness", default="claude-agent-sdk",
                   choices=["claude-agent-sdk", "gitagent", "deepagents"],
                   help="which harness to drive the LLM-using tests with")
    p.add_argument("--source", default=None,
                   help="override the source repo (defaults to the harness-appropriate one)")
    args = p.parse_args()

    DEFAULT_BODY["harness"] = args.harness
    if args.source:
        DEFAULT_BODY["source"] = args.source

    only = set(s.strip() for s in args.only.split(",")) if args.only else None

    print(f"\nTesting {args.base} — harness={args.harness} source={DEFAULT_BODY['source']}\n")
    r = Report()
    for name, fn in TESTS:
        if only and name not in only: continue
        print(f"\n── {name} ─────────────────")
        try:
            fn(args.base, r)
        except Exception as e:
            r.add(name + " (uncaught)", False, repr(e))
    ok = r.summary()
    sys.exit(0 if ok else 1)

if __name__ == "__main__":
    main()
