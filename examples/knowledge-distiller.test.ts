/**
 * Unit tests for the knowledge distiller's pure logic: the PII scrub (the hard
 * requirement — no personal/user-specific data may survive), dedup, hashing, and
 * repo parsing. These need no Mongo or network.
 */
import { describe, expect, it } from "vitest";
import { dedupe, normalizeHash, parseRepo, piiReject } from "./knowledge-distiller.ts";

describe("piiReject", () => {
  it("accepts generic company facts", () => {
    expect(piiReject("The company deploys agents via a bubblewrap sandbox on EC2.")).toBeNull();
    expect(piiReject("The billing service charges per active sandbox-hour.")).toBeNull();
    expect(piiReject("Releases are cut from the deploy branch, which rebuilds the ECR images.")).toBeNull();
  });

  it("drops emails, tokens, and JWTs", () => {
    expect(piiReject("Contact the owner at jane.doe@acme.com for access.")).not.toBeNull();
    expect(piiReject("The service key is sk-ant-api03-abcdef0123456789ABCDEF.")).not.toBeNull();
    expect(piiReject("Deploy token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.")).not.toBeNull();
    expect(piiReject("Session eyJhbGciOiJIUzI1NiIsInR5cCI.eyJzdWIiOiIxMjM0NTY.abcdef123456")).not.toBeNull();
    expect(piiReject("AWS key AKIAIOSFODNN7EXAMPLE was rotated.")).not.toBeNull();
  });

  it("drops Slack mentions/user ids and phone numbers", () => {
    expect(piiReject("Ping <@U012AB3CD> when the build is green.")).not.toBeNull();
    expect(piiReject("The on-call reaches U08ZZ12QKP for escalation.")).not.toBeNull();
    expect(piiReject("Call the support line at +1 (415) 555-0198 for urgent issues.")).not.toBeNull();
  });

  it("drops personal attribution ('X said/wants/prefers')", () => {
    expect(piiReject("Shreyas prefers the reports in a table format.")).not.toBeNull();
    expect(piiReject("Abhishek asked for the migration to run overnight.")).not.toBeNull();
    expect(piiReject("Sarah said the onboarding flow is confusing.")).not.toBeNull();
    expect(piiReject("My email is on file for the newsletter.")).not.toBeNull();
  });

  it("drops trivially short statements", () => {
    expect(piiReject("Yes.")).toBe("too-short");
    expect(piiReject("ok thanks")).toBe("too-short");
  });
});

describe("normalizeHash + dedupe", () => {
  it("hashes semantically-equal statements to the same value", () => {
    const a = normalizeHash("The company uses MongoDB Atlas.");
    const b = normalizeHash("the   company uses mongodb atlas!!!");
    expect(a).toBe(b);
  });

  it("skips statements already in the seen set and within the batch", () => {
    const seen = new Set([normalizeHash("The platform runs on EKS.")]);
    const { fresh, hashes } = dedupe(
      [
        "The platform runs on EKS.", // already seen
        "The API is rate-limited to 4 concurrent runs.", // new
        "the api is rate limited to 4 concurrent runs", // dup of the above within-batch
      ],
      seen,
    );
    expect(fresh).toEqual(["The API is rate-limited to 4 concurrent runs."]);
    expect(hashes).toHaveLength(1);
  });
});

describe("parseRepo", () => {
  it("parses bare, https, and .git forms", () => {
    expect(parseRepo("github.com/example-org/agent-repo")).toEqual({ owner: "example-org", name: "agent-repo" });
    expect(parseRepo("https://github.com/example-org/agent-repo.git")).toEqual({ owner: "example-org", name: "agent-repo" });
    expect(parseRepo("git@github.com:example-org/agent-repo.git")).toEqual({ owner: "example-org", name: "agent-repo" });
  });

  it("throws on unparseable input", () => {
    expect(() => parseRepo("not-a-repo")).toThrow();
  });
});
