import { describe, test, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliError } from "../../src/api/errors.js";
import {
  parseJsonBodyFlag,
  readJsonObjectInput,
  resolveJsonObjectBody,
} from "../../src/api/parseBody.js";

describe("parseJsonBodyFlag", () => {
  test("parses a valid JSON object", () => {
    expect(parseJsonBodyFlag('{"a":1}')).toEqual({ a: 1 });
  });

  test("throws CliError(exit 4) on malformed JSON", () => {
    try {
      parseJsonBodyFlag("{not json}");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(CliError);
      expect((e as CliError).exitCode).toBe(4);
    }
  });

  test("throws CliError(exit 4) when the body is not an object", () => {
    try {
      parseJsonBodyFlag("[1,2,3]");
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as CliError).exitCode).toBe(4);
    }
  });

  test("hint echoes the raw body and warns about shell quote-stripping when quotes are missing", () => {
    try {
      parseJsonBodyFlag("{personEmail:x@y.fi}");
      throw new Error("should have thrown");
    } catch (e) {
      const hint = (e as CliError).hint ?? "";
      expect(hint).toContain("received: {personEmail:x@y.fi}");
      expect(hint).toContain("--from-json");
      expect(hint).toContain("PowerShell");
    }
  });

  test("hint does NOT claim quote-stripping when quotes are present", () => {
    try {
      parseJsonBodyFlag('{"a":}');
      throw new Error("should have thrown");
    } catch (e) {
      const hint = (e as CliError).hint ?? "";
      expect(hint).toContain("received:");
      expect(hint).not.toContain("PowerShell");
    }
  });
});

describe("readJsonObjectInput", () => {
  test("reads and parses a JSON object file, stripping a BOM", () => {
    const dir = mkdtempSync(join(tmpdir(), "ib-parsebody-"));
    const file = join(dir, "body.json");
    try {
      writeFileSync(file, '\uFEFF{"personEmail":"a@b.fi"}', "utf8");
      expect(readJsonObjectInput(file)).toEqual({ personEmail: "a@b.fi" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("exit 4 when the file is not a JSON object", () => {
    const dir = mkdtempSync(join(tmpdir(), "ib-parsebody-"));
    const file = join(dir, "body.json");
    try {
      writeFileSync(file, "[1,2,3]", "utf8");
      readJsonObjectInput(file);
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as CliError).exitCode).toBe(4);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("exit 4 when the file cannot be read", () => {
    try {
      readJsonObjectInput(join(tmpdir(), "does-not-exist-ib.json"));
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as CliError).exitCode).toBe(4);
    }
  });
});

describe("resolveJsonObjectBody", () => {
  test("returns null when neither --body nor --from-json is set", () => {
    expect(resolveJsonObjectBody({})).toBeNull();
  });

  test("parses inline --body", () => {
    expect(resolveJsonObjectBody({ body: '{"a":1}' })).toEqual({ a: 1 });
  });

  test("reads --from-json from a file", () => {
    const dir = mkdtempSync(join(tmpdir(), "ib-parsebody-"));
    const file = join(dir, "body.json");
    try {
      writeFileSync(file, '{"b":2}', "utf8");
      expect(resolveJsonObjectBody({ fromJson: file })).toEqual({ b: 2 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("exit 4 when both --body and --from-json are supplied", () => {
    try {
      resolveJsonObjectBody({ body: '{"a":1}', fromJson: "./x.json" });
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as CliError).exitCode).toBe(4);
      expect((e as CliError).message).toContain("mutually exclusive");
    }
  });
});

/**
 * fb#307 — these failures are raised locally, before any request. They used to
 * carry a fabricated `statusCode: 400`, which told the caller the BACKEND had
 * rejected a request that was never sent, made `hintForError` serve an `http:400`
 * row's remedy (a missing FILE answered with "check --type/--area/--date"), and
 * logged the same lie to the friction store.
 */
describe("locally-raised parse failures declare client origin (statusCode 0)", () => {
  const captured = (fn: () => unknown): CliError => {
    try {
      fn();
    } catch (e) {
      return e as CliError;
    }
    throw new Error("should have thrown");
  };

  test("a missing --from-json file is client-origin, not an HTTP 400", () => {
    const err = captured(() => readJsonObjectInput(join(tmpdir(), "ib-does-not-exist-9f3a.json")));
    expect(err.statusCode).toBe(0);
    expect(err.exitCode).toBe(4);
  });

  test.each([
    ["invalid --body JSON", () => parseJsonBodyFlag("{not json}")],
    ["non-object --body", () => parseJsonBodyFlag("[1,2,3]")],
    ["both --body and --from-json", () => resolveJsonObjectBody({ body: "{}", fromJson: "./x.json" })],
  ])("%s is client-origin", (_label, fn) => {
    expect(captured(fn).statusCode).toBe(0);
  });

  test("a malformed --from-json file is client-origin", () => {
    const dir = mkdtempSync(join(tmpdir(), "ib-parsebody-"));
    const file = join(dir, "bad.json");
    try {
      writeFileSync(file, "{not json}", "utf8");
      expect(captured(() => readJsonObjectInput(file)).statusCode).toBe(0);
      writeFileSync(file, "[1,2,3]", "utf8");
      expect(captured(() => readJsonObjectInput(file)).statusCode).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
