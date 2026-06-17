import { describe, test, expect } from "vitest";
import { extractJsonCandidate, validateStructuredJson } from "../../src/commands/legal/validateJson.js";

describe("validateStructuredJson (#2)", () => {
  test("accepts a well-formed fenced ```json object", () => {
    const md = "Intro text\n\n```json\n{ \"ctaLabel\": \"X\" }\n```\n";
    expect(validateStructuredJson(md)).toEqual({ ok: true });
  });

  test("accepts whole-content JSON (no fence)", () => {
    expect(validateStructuredJson('{ "a": 1 }')).toEqual({ ok: true });
  });

  test("rejects a malformed fenced block", () => {
    const md = "```json\n{ \"ctaLabel\": \"X\", }\n```"; // trailing comma
    const r = validateStructuredJson(md);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/does not parse/i);
  });

  test("rejects a JSON array (must be an object)", () => {
    expect(validateStructuredJson('```json\n[1,2,3]\n```').ok).toBe(false);
  });

  test("rejects empty content", () => {
    expect(validateStructuredJson("   ").ok).toBe(false);
  });

  test("extractJsonCandidate mirrors the FE fence regex", () => {
    expect(extractJsonCandidate("a\n```json\n{\"x\":1}\n```\nb")).toBe('{"x":1}');
    expect(extractJsonCandidate('{"y":2}')).toBe('{"y":2}');
  });
});
