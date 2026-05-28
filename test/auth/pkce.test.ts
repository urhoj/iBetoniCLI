import { describe, test, expect } from "vitest";
import { createHash } from "node:crypto";
import { generatePkcePair, generateState } from "../../src/auth/pkce";

describe("PKCE", () => {
  test("generatePkcePair returns base64url verifier + S256 challenge", () => {
    const { verifier, challenge, method } = generatePkcePair();
    expect(method).toBe("S256");
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
    const expected = createHash("sha256").update(verifier).digest("base64url");
    expect(challenge).toBe(expected);
  });

  test("generateState returns 32-byte hex string (64 chars)", () => {
    const state = generateState();
    expect(state).toMatch(/^[0-9a-f]{64}$/);
  });

  test("each call produces a different verifier", () => {
    const a = generatePkcePair();
    const b = generatePkcePair();
    expect(a.verifier).not.toBe(b.verifier);
  });
});
