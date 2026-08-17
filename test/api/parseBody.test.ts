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

/**
 * The three --from-json failures used to share ONE hint, taken from the command's
 * generic spec row: "check the path; the root must be an object and every key an
 * accepted field name". On a SYNTAX error the parser never reached a key, so that
 * advice sent the caller off to audit field names that were already correct
 * (feedback #705). Each failure now carries its own hint, and the point of these
 * tests is that the hints do not describe each other's failure.
 */
describe("readJsonObjectInput hints (feedback #705)", () => {
  /** Run readJsonObjectInput over `content` and return the thrown CliError. */
  function errorFor(content: string): CliError {
    const dir = mkdtempSync(join(tmpdir(), "ib-fromjson-hint-"));
    const file = join(dir, "body.json");
    try {
      writeFileSync(file, content, "utf8");
      readJsonObjectInput(file);
      throw new Error("should have thrown");
    } catch (e) {
      return e as CliError;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("a SYNTAX error says no field was read yet, and does not send you to the key names", () => {
    const hint = errorFor('{"a":}').hint ?? "";
    expect(hint).toContain("not valid JSON");
    expect(hint).toContain("no field was read yet");
    // The wrong advice this whole fix exists to remove.
    expect(hint).not.toContain("accepted field name");
  });

  // V8 emits TWO message shapes and the region fills the gap in one of them:
  //   "Expected ',' … at position 19 (line 1 column 20)"  -> position, NO snippet
  //   "Unexpected token ',', ...\"beta\":,\"gam\"... is not valid JSON" -> snippet, no position
  // Only the first needs us to echo the text; duplicating V8's own snippet in the
  // second would be noise, which is why a position-less message gets no region.
  test("a positional SYNTAX error shows the received text around the offset", () => {
    const hint = errorFor('{"alpha":1,"beta":2').hint ?? "";
    expect(hint).toContain("around the reported offset");
    expect(hint).toContain("beta");
    expect(hint).toContain("^");
  });

  test("a SYNTAX error that carries V8's own snippet is not given a second one", () => {
    const err = errorFor('{"alpha":1,"beta":,"gamma":3}');
    expect(err.message).toContain("is not valid JSON"); // the snippet-bearing shape
    expect(err.hint ?? "").not.toContain("around the reported offset");
  });

  test("a backslash in a failing payload names the pipe-collapse cause and points at a file", () => {
    // A lone backslash is what a heredoc delivers for BOTH `\\` and `\` on Git
    // Bash, so JSON reads it as a bad escape. Verified 2026-08-17.
    const hint = errorFor('{"d":"path <root>\\HEAD"}').hint ?? "";
    expect(hint).toContain("backslash");
    expect(hint).toContain("FILE");
  });

  test("a syntax error with NO backslash does not mention one", () => {
    const hint = errorFor('{"a":}').hint ?? "";
    expect(hint).not.toContain("backslash");
  });

  test("an ARRAY root is told it parsed fine and names the shape it got", () => {
    const hint = errorFor('[{"a":1}]').hint ?? "";
    expect(hint).toContain("parsed fine");
    expect(hint).toContain("an array");
    expect(hint).not.toContain("not valid JSON");
  });

  test("a SCALAR root names its actual type rather than saying 'array'", () => {
    expect(errorFor('"just a string"').hint ?? "").toContain("a string");
    expect(errorFor("42").hint ?? "").toContain("a number");
    expect(errorFor("null").hint ?? "").toContain("null");
  });

  test("an unreadable PATH is the one failure whose hint IS about the path", () => {
    let err: CliError;
    try {
      readJsonObjectInput(join(tmpdir(), "does-not-exist-ib-hint.json"));
      throw new Error("should have thrown");
    } catch (e) {
      err = e as CliError;
    }
    const hint = err.hint ?? "";
    expect(hint).toContain("path");
    expect(hint).not.toContain("not valid JSON");
  });

  // NOT tested here: readJsonObjectInput("-") when stdin has nothing to give.
  // readFileSync(0) BLOCKS on an inherited stdin rather than failing, so the
  // obvious test hangs the worker forever instead of failing. The `-` branch of
  // that hint is exercised through the CLI, not from a unit test.
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
