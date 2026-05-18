#!/usr/bin/env python3
"""
Wedge 1.13 — S3-backed StateStore round-trip tests.

Hits the live ComputerAgentServer (default https://api.clawagent.sh) with
stateStore: { kind: "s3", options: { bucket: <env S3_BUCKET> } }.

Requires:
  - S3_BUCKET    — the bucket the server was configured with
                   (otherwise it lists from a different bucket and tests fail)
  - AWS creds (for cross-check via aws cli) optional; tests still run if the
    server has its own creds wired via env / instance role.

Run:
  S3_BUCKET=clawagent-sandbox-snapshots-test \
    python3 scripts/test-sandboxes-s3.py --base https://api.clawagent.sh
"""

import argparse, json, os, subprocess, sys, time, threading
from contextlib import contextmanager
from concurrent.futures import ThreadPoolExecutor

# Share helpers with the main suite by importing it as a module. Keeps
# wire/SSE/sandbox-create code in one place.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from importlib import import_module
ts = import_module("test-sandboxes")

# Mirror its globals + helpers we use directly.
http = ts.http
jget = ts.jget
jpost = ts.jpost
jdelete = ts.jdelete
sse_chat = ts.sse_chat
Report = ts.Report
sandbox = ts.sandbox
DEFAULT_BODY = ts.DEFAULT_BODY


def t_s3_list_endpoint(base, r, bucket):
    """Cheapest possible health check: list against real S3."""
    s, doc = jget(f"{base}/snapshots?stateStore=s3&bucket={bucket}")
    r.add("GET /snapshots?stateStore=s3 returns 200 + snapshots array",
          s == 200 and "snapshots" in doc,
          f"status={s} keys={list(doc.keys())}")


def t_s3_snapshot_round_trip(base, r, bucket):
    """Seed file via attachment, snapshot to real S3, restore, verify."""
    body = {
        **DEFAULT_BODY,
        "attachments": [
            {"path": "test-s3-marker.txt", "content": "STARFISH-7", "encoding": "utf8"},
        ],
    }
    s, doc = jpost(f"{base}/sandboxes", body)
    if s != 201:
        r.add("create with s3 attachments", False, f"got {s}: {doc}")
        return
    sid = doc["sandboxId"]
    snapshot_id = None
    new_sid = None
    harness = DEFAULT_BODY["harness"]
    agent_sees_os_workdir = harness in ("claude-agent-sdk", "gitagent")
    try:
        sse_chat(base, sid, "Reply with: OK")

        sn = jpost(f"{base}/sandboxes/{sid}/snapshot",
                   {"stateStore": {"kind": "s3", "options": {"bucket": bucket}}})
        r.add("S3 snapshot returns 200 + snapshotId",
              sn[0] == 200 and sn[1].get("snapshotId", "").startswith("snap_"),
              str(sn[1]))
        snapshot_id = sn[1].get("snapshotId", "")
        size = sn[1].get("sizeBytes", 0)
        files = sn[1].get("fileCount", 0)
        r.add("S3 snapshot reports byte count + file count",
              size > 0 and files > 0,
              f"size={size}B files={files}")

        # Independently verify the objects landed in S3 via the AWS CLI.
        try:
            meta = subprocess.run(
                ["aws", "s3", "ls", f"s3://{bucket}/sandboxes/snapshots/{snapshot_id}/"],
                capture_output=True, text=True, timeout=10,
            )
            ok = "meta.json" in meta.stdout and "workdir.tar.gz" in meta.stdout
            r.add("S3 objects (meta.json + workdir.tar.gz) actually written",
                  ok, meta.stdout.strip().replace("\n", " ; ") if ok else f"out={meta.stdout!r} err={meta.stderr!r}")
        except (FileNotFoundError, subprocess.TimeoutExpired) as e:
            r.skip("S3 objects cross-check (aws cli)", repr(e))

        rr = jpost(f"{base}/sandboxes/restore", {
            "snapshotId": snapshot_id,
            "stateStore": {"kind": "s3", "options": {"bucket": bucket}},
            "target": "new",
        })
        r.add("S3 restore returns 201 + new sandboxId",
              rr[0] == 201 and rr[1].get("sandboxId", "").startswith("sbx_") and rr[1].get("restored"),
              str(rr[1]))
        new_sid = rr[1].get("sandboxId", "")

        # Structural verification: re-snapshot restored sandbox + compare file count.
        sse_chat(base, new_sid, "Reply with: OK")
        sn2 = jpost(f"{base}/sandboxes/{new_sid}/snapshot",
                    {"stateStore": {"kind": "s3", "options": {"bucket": bucket}}})
        restored_files = sn2[1].get("fileCount", 0) if sn2[0] == 200 else 0
        r.add("restored workdir from S3 matches original file count",
              abs(restored_files - files) <= 2,
              f"orig={files} restored={restored_files}")
        # Clean up the secondary snapshot from S3.
        if sn2[0] == 200:
            jdelete(f"{base}/snapshots/{sn2[1]['snapshotId']}?stateStore=s3&bucket={bucket}")

        if agent_sees_os_workdir:
            _, _, txt, _ = sse_chat(base, new_sid, "Use the Read tool to read test-s3-marker.txt and reply with only its content.")
            r.add("restored workdir from S3 readable by agent (seed file)",
                  "STARFISH-7" in (txt or ""),
                  f"got {txt!r}")
        else:
            r.skip("restored workdir readable by agent (seed file)",
                   f"{harness}: virtual-FS gap — agent tools don't see OS workdir")
    finally:
        if new_sid: jdelete(f"{base}/sandboxes/{new_sid}")
        jdelete(f"{base}/sandboxes/{sid}")
        if snapshot_id:
            jdelete(f"{base}/snapshots/{snapshot_id}?stateStore=s3&bucket={bucket}")


def t_s3_autosave_on_dispose(base, r, bucket):
    """autoSave wired to s3 lands a snapshot in the bucket on DELETE."""
    body = {
        **DEFAULT_BODY,
        "idleTtlMs": 120000,
        "ttlMs": 240000,
        "autoSave": {"stateStore": {"kind": "s3", "options": {"bucket": bucket}}},
    }
    s, doc = jpost(f"{base}/sandboxes", body)
    if s != 201:
        r.add("autoSave-s3 create", False, f"got {s}: {doc}")
        return
    sid = doc["sandboxId"]
    try:
        sse_chat(base, sid, "Reply with: OK")
        d_s, d_doc = jdelete(f"{base}/sandboxes/{sid}")
        r.add("DELETE returns autoSaved:true (s3)",
              d_s == 200 and d_doc.get("autoSaved") is True,
              str(d_doc))
        # Wait for S3 consistency (us-east-2 is strong now but be polite).
        time.sleep(1)
        l_s, l_doc = jget(f"{base}/snapshots?stateStore=s3&bucket={bucket}")
        matches = [x for x in l_doc.get("snapshots", []) if x.get("sourceSandboxId") == sid]
        r.add("autoSave-s3 produced a discoverable snapshot in the bucket",
              len(matches) >= 1,
              f"matches={len(matches)} all={[x.get('snapshotId') for x in l_doc.get('snapshots', [])][:5]}")
        # Cleanup the autosave snapshot.
        if matches:
            jdelete(f"{base}/snapshots/{matches[0]['snapshotId']}?stateStore=s3&bucket={bucket}")
    finally:
        jdelete(f"{base}/sandboxes/{sid}")


def t_s3_delete_snapshot(base, r, bucket):
    """DELETE /snapshots/:id removes both objects from S3."""
    # Create a small snapshot first.
    body = {**DEFAULT_BODY, "attachments": [{"path": "ephemeral.txt", "content": "z", "encoding": "utf8"}]}
    s, doc = jpost(f"{base}/sandboxes", body)
    if s != 201:
        r.add("delete snapshot create", False, str(doc))
        return
    sid = doc["sandboxId"]
    try:
        sse_chat(base, sid, "Reply with: OK")
        sn = jpost(f"{base}/sandboxes/{sid}/snapshot",
                   {"stateStore": {"kind": "s3", "options": {"bucket": bucket}}})
        if sn[0] != 200:
            r.add("delete snapshot precondition", False, str(sn[1]))
            return
        snap_id = sn[1]["snapshotId"]
        d_s, d_doc = jdelete(f"{base}/snapshots/{snap_id}?stateStore=s3&bucket={bucket}")
        r.add("DELETE /snapshots/:id returns ok:true",
              d_s == 200 and d_doc.get("ok") is True,
              str(d_doc))
        # Verify S3 actually emptied.
        try:
            ls = subprocess.run(
                ["aws", "s3", "ls", f"s3://{bucket}/sandboxes/snapshots/{snap_id}/"],
                capture_output=True, text=True, timeout=10,
            )
            r.add("S3 objects gone after DELETE",
                  ls.stdout.strip() == "",
                  f"stdout={ls.stdout!r}")
        except (FileNotFoundError, subprocess.TimeoutExpired) as e:
            r.skip("S3 cleanup cross-check (aws cli)", repr(e))
    finally:
        jdelete(f"{base}/sandboxes/{sid}")


TESTS = [
    ("s3_list_endpoint",          t_s3_list_endpoint),
    ("s3_snapshot_round_trip",    t_s3_snapshot_round_trip),
    ("s3_autosave_on_dispose",    t_s3_autosave_on_dispose),
    ("s3_delete_snapshot",        t_s3_delete_snapshot),
]


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--base", default="https://api.clawagent.sh")
    p.add_argument("--bucket", default=os.environ.get("S3_BUCKET"))
    p.add_argument("--only", help="comma-separated subset of test names")
    p.add_argument("--harness", default="claude-agent-sdk",
                   choices=["claude-agent-sdk", "gitagent", "deepagents"])
    args = p.parse_args()
    if not args.bucket:
        print("ERROR: pass --bucket or set S3_BUCKET", file=sys.stderr)
        sys.exit(2)
    # Override the shared DEFAULT_BODY so the imported test-sandboxes helpers
    # use the requested harness.
    ts.DEFAULT_BODY["harness"] = args.harness
    only = set(s.strip() for s in args.only.split(",")) if args.only else None
    print(f"\nTesting {args.base} against bucket {args.bucket} — harness={args.harness}\n")
    r = Report()
    for name, fn in TESTS:
        if only and name not in only: continue
        print(f"\n── {name} ─────────────────")
        try:
            fn(args.base, r, args.bucket)
        except Exception as e:
            r.add(name + " (uncaught)", False, repr(e))
    ok = r.summary()
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
