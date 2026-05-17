import { describe, expect, it } from "vitest";
import { buildBwrapArgs } from "./bwrap-args.js";

describe("buildBwrapArgs", () => {
  const baseInput = {
    bundlePath: "/host/path/harness-bundle.mjs",
    nodePath: "/usr/bin/node",
    workdir: "/tmp/sessions/abc123",
    port: 54321,
    envs: { ANTHROPIC_API_KEY: "sk-test", MONGO_URL: "mongodb://x:27017" },
  };

  it("includes the core isolation flags", () => {
    const argv = buildBwrapArgs(baseInput);
    expect(argv).toContain("--unshare-all");
    expect(argv).toContain("--share-net");
    expect(argv).toContain("--die-with-parent");
    expect(argv).toContain("--new-session");
    // --cap-drop ALL must appear as two consecutive args.
    const capIdx = argv.indexOf("--cap-drop");
    expect(capIdx).toBeGreaterThan(-1);
    expect(argv[capIdx + 1]).toBe("ALL");
  });

  it("hermetic mode drops --share-net", () => {
    const argv = buildBwrapArgs({ ...baseInput, shareNetwork: false });
    expect(argv).not.toContain("--share-net");
  });

  it("bind-mounts the workdir read-write and the bundle read-only", () => {
    const argv = buildBwrapArgs(baseInput);
    const bindIdx = argv.indexOf("--bind");
    expect(bindIdx).toBeGreaterThan(-1);
    expect(argv[bindIdx + 1]).toBe(baseInput.workdir);
    expect(argv[bindIdx + 2]).toBe("/workdir");

    // Bundle should be ro-bind, not bind
    const bundleIdx = argv.findIndex(
      (v, i) => v === "--ro-bind" && argv[i + 1] === baseInput.bundlePath,
    );
    expect(bundleIdx).toBeGreaterThan(-1);
    expect(argv[bundleIdx + 2]).toBe("/harness/harness.mjs");
  });

  it("binds the node binary at /opt/node/bin/node read-only", () => {
    // We deliberately don't bind into /usr/local/bin because /usr is mounted
    // read-only via --ro-bind-try; bwrap can't create new files under a path
    // that's already been bound read-only.
    const argv = buildBwrapArgs(baseInput);
    const nodeIdx = argv.findIndex(
      (v, i) => v === "--ro-bind" && argv[i + 1] === baseInput.nodePath,
    );
    expect(nodeIdx).toBeGreaterThan(-1);
    expect(argv[nodeIdx + 2]).toBe("/opt/node/bin/node");
  });

  it("forwards every env var via --setenv", () => {
    const argv = buildBwrapArgs(baseInput);
    for (const [k, v] of Object.entries(baseInput.envs)) {
      const idx = argv.findIndex(
        (a, i) => a === "--setenv" && argv[i + 1] === k && argv[i + 2] === v,
      );
      expect(idx, `env ${k}`).toBeGreaterThan(-1);
    }
    // PORT, HOME, PATH always set
    const portIdx = argv.findIndex(
      (a, i) => a === "--setenv" && argv[i + 1] === "PORT",
    );
    expect(argv[portIdx + 2]).toBe("54321");
    const homeIdx = argv.findIndex(
      (a, i) => a === "--setenv" && argv[i + 1] === "HOME",
    );
    expect(argv[homeIdx + 2]).toBe("/workdir");
  });

  it("ends with -- /opt/node/bin/node /harness/harness.mjs", () => {
    const argv = buildBwrapArgs(baseInput);
    const tail = argv.slice(-3);
    expect(tail).toEqual(["--", "/opt/node/bin/node", "/harness/harness.mjs"]);
  });

  it("includes the read-only system + TLS bindings", () => {
    const argv = buildBwrapArgs(baseInput);
    // Each --ro-bind-try is followed by two paths
    const expected = ["/usr", "/lib", "/lib64", "/bin", "/sbin", "/etc/resolv.conf", "/etc/ssl"];
    for (const p of expected) {
      const idx = argv.findIndex(
        (a, i) => a === "--ro-bind-try" && argv[i + 1] === p && argv[i + 2] === p,
      );
      expect(idx, `ro-bind-try ${p}`).toBeGreaterThan(-1);
    }
  });

  it("applies extra read-only binds with optional dest", () => {
    const argv = buildBwrapArgs({
      ...baseInput,
      extraRoBinds: [
        { src: "/opt/python3" },
        { src: "/opt/secrets/.npmrc", dest: "/etc/npmrc" },
      ],
    });
    const pyIdx = argv.findIndex(
      (a, i) => a === "--ro-bind" && argv[i + 1] === "/opt/python3" && argv[i + 2] === "/opt/python3",
    );
    expect(pyIdx).toBeGreaterThan(-1);
    const npmrcIdx = argv.findIndex(
      (a, i) => a === "--ro-bind" && argv[i + 1] === "/opt/secrets/.npmrc" && argv[i + 2] === "/etc/npmrc",
    );
    expect(npmrcIdx).toBeGreaterThan(-1);
  });

  it("mounts a private tmpfs over /tmp and /var/tmp", () => {
    const argv = buildBwrapArgs(baseInput);
    const tmpIdx = argv.findIndex(
      (a, i) => a === "--tmpfs" && argv[i + 1] === "/tmp",
    );
    expect(tmpIdx).toBeGreaterThan(-1);
    const varTmpIdx = argv.findIndex(
      (a, i) => a === "--tmpfs" && argv[i + 1] === "/var/tmp",
    );
    expect(varTmpIdx).toBeGreaterThan(-1);
  });

  it("changes the working directory to /workdir", () => {
    const argv = buildBwrapArgs(baseInput);
    const idx = argv.indexOf("--chdir");
    expect(idx).toBeGreaterThan(-1);
    expect(argv[idx + 1]).toBe("/workdir");
  });
});
