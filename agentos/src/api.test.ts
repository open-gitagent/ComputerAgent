/**
 * Pure-function unit tests for `displaySource`. No DOM, no fetch, no React.
 *
 * displaySource is the load-bearing piece behind <SourceBadge> in the agent
 * rail: it turns the variable-shaped `agent.source` (git/local/inline object
 * OR a legacy bare string) into a render-ready `{kind, primary, secondary,
 * href?}` triple. Wrong output here = the dashboard renders the wrong title
 * or links to the wrong repo, so we exercise every recognized shape + every
 * fallback branch.
 */
import { describe, expect, it } from "vitest";
import { displaySource } from "./api.js";

describe("displaySource", () => {
  describe("null / undefined input", () => {
    it("returns the (no source) unknown sentinel for undefined", () => {
      expect(displaySource(undefined)).toEqual({
        kind: "unknown",
        primary: "(no source)",
        secondary: "",
      });
    });
    it("returns the (no source) unknown sentinel for null", () => {
      expect(displaySource(null)).toEqual({
        kind: "unknown",
        primary: "(no source)",
        secondary: "",
      });
    });
    it("returns the (no source) unknown sentinel for empty string", () => {
      expect(displaySource("")).toEqual({
        kind: "unknown",
        primary: "(no source)",
        secondary: "",
      });
    });
  });

  describe("structured local source", () => {
    it("uses the last two path segments as the primary label", () => {
      expect(displaySource({ type: "local", path: "/Users/zeus/repos/devsupport-agent" })).toEqual({
        kind: "local",
        primary: "repos/devsupport-agent",
        secondary: "/Users/zeus/repos/devsupport-agent",
      });
    });
    it("falls back to the full path when there's only one segment", () => {
      expect(displaySource({ type: "local", path: "/agent" })).toEqual({
        kind: "local",
        primary: "agent",
        secondary: "/agent",
      });
    });
    it("handles a trailing slash without producing an empty primary", () => {
      const out = displaySource({ type: "local", path: "/Users/zeus/x/" });
      expect(out.kind).toBe("local");
      expect(out.primary.length).toBeGreaterThan(0);
    });
  });

  describe("structured inline source", () => {
    it("uses manifest.name when present", () => {
      expect(
        displaySource({ type: "inline", manifest: { name: "ad-hoc-bot" } }),
      ).toEqual({ kind: "inline", primary: "ad-hoc-bot", secondary: "inline manifest" });
    });
    it("falls back to 'inline' when manifest has no name", () => {
      expect(displaySource({ type: "inline", manifest: { spec_version: "0.1.0" } })).toEqual({
        kind: "inline",
        primary: "inline",
        secondary: "inline manifest",
      });
    });
    it("falls back to 'inline' when manifest.name is not a string", () => {
      expect(
        displaySource({
          type: "inline",
          manifest: { name: 42 as unknown as string },
        }),
      ).toEqual({ kind: "inline", primary: "inline", secondary: "inline manifest" });
    });
  });

  describe("structured git source", () => {
    it("parses an https URL with .git suffix into owner/repo + host + href", () => {
      expect(
        displaySource({
          type: "git",
          url: "https://github.com/open-gitagent/ComputerAgent.git",
        }),
      ).toEqual({
        kind: "git",
        primary: "open-gitagent/ComputerAgent",
        secondary: "github.com",
        href: "https://github.com/open-gitagent/ComputerAgent",
      });
    });
    it("parses an ssh git@ URL into owner/repo + host + https href", () => {
      expect(
        displaySource({ type: "git", url: "git@github.com:open-gitagent/opengap.git" }),
      ).toEqual({
        kind: "git",
        primary: "open-gitagent/opengap",
        secondary: "github.com",
        href: "https://github.com/open-gitagent/opengap",
      });
    });
    it("appends /tree/<ref> to the href when ref is provided", () => {
      expect(
        displaySource({
          type: "git",
          url: "https://github.com/open-gitagent/ComputerAgent",
          ref: "main",
        }),
      ).toEqual({
        kind: "git",
        primary: "open-gitagent/ComputerAgent",
        secondary: "github.com",
        href: "https://github.com/open-gitagent/ComputerAgent/tree/main",
      });
    });
    it("url-encodes a ref containing a slash", () => {
      const out = displaySource({
        type: "git",
        url: "https://github.com/o/r",
        ref: "feat/abc",
      });
      expect(out.href).toBe("https://github.com/o/r/tree/feat%2Fabc");
    });
    it("recognizes gitlab.com hosts", () => {
      expect(
        displaySource({ type: "git", url: "https://gitlab.com/my-org/my-repo" }),
      ).toEqual({
        kind: "git",
        primary: "my-org/my-repo",
        secondary: "gitlab.com",
        href: "https://gitlab.com/my-org/my-repo",
      });
    });
    it("recognizes bitbucket.org hosts", () => {
      expect(
        displaySource({ type: "git", url: "https://bitbucket.org/team/proj.git" }),
      ).toEqual({
        kind: "git",
        primary: "team/proj",
        secondary: "bitbucket.org",
        href: "https://bitbucket.org/team/proj",
      });
    });
    it("parses a scheme-less host/owner/repo", () => {
      expect(displaySource({ type: "git", url: "github.com/o/r" })).toEqual({
        kind: "git",
        primary: "o/r",
        secondary: "github.com",
        href: "https://github.com/o/r",
      });
    });
    it("treats a bare owner/repo (no host) as github by default", () => {
      expect(displaySource({ type: "git", url: "open-gitagent/opengap" })).toEqual({
        kind: "git",
        primary: "open-gitagent/opengap",
        secondary: "github.com",
        href: "https://github.com/open-gitagent/opengap",
      });
    });
  });

  describe("legacy string source", () => {
    it("treats a full https URL the same as the structured form", () => {
      const expected = {
        kind: "git" as const,
        primary: "open-gitagent/ComputerAgent",
        secondary: "github.com",
        href: "https://github.com/open-gitagent/ComputerAgent",
      };
      expect(displaySource("https://github.com/open-gitagent/ComputerAgent")).toEqual(expected);
    });
    it("treats a bare owner/repo string as github", () => {
      expect(displaySource("open-gitagent/opengap")).toEqual({
        kind: "git",
        primary: "open-gitagent/opengap",
        secondary: "github.com",
        href: "https://github.com/open-gitagent/opengap",
      });
    });
  });

  describe("unrecognized shapes fall back cleanly", () => {
    it("returns kind=unknown with raw primary when there's only one path segment", () => {
      expect(displaySource("just-a-name")).toEqual({
        kind: "unknown",
        primary: "just-a-name",
        secondary: "",
      });
    });
  });
});
