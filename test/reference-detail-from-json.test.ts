import { describe, test, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runArgv } from "../src/runArgv.js";

/**
 * fb#613 — `ib reference detail set --from-json <file|->`.
 *
 * The command writes long Finnish-bearing prose into dbo.ibcli_commandCatalog,
 * and Windows PowerShell reinterprets UTF-8 native arguments as latin1, so
 * `Ylijäämäbetonin` was stored as `YlijÃ¤Ã¤mÃ¤betonin` while the call exited 0
 * and echoed success. Uniquely invisible here: the catalog is served to AI
 * agents as authoritative, sits outside git, and nothing diffs or lints it.
 *
 * These exercise the wiring specific to THIS command — the derived accepted-key
 * set and the ordering against the edit-mode guards. The merge/precedence
 * contract itself belongs to the shared helper and is covered with it.
 */
describe("ib reference detail set --from-json (fb#613)", () => {
  const opts = { token: "", endpoint: "https://example.invalid" };
  let dir: string;
  const write = (name: string, body: unknown): string => {
    const p = join(dir, name);
    writeFileSync(p, JSON.stringify(body), "utf8");
    return p;
  };

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "ib-fb613-"));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("rejects an unknown key and names the accepted set", async () => {
    const file = write("bad.json", { bogus: "x" });
    const { exitCode, stderr } = await runArgv(
      ["reference", "detail", "set", "keikka", "list", "--from-json", file],
      opts
    );
    expect(exitCode).toBe(4);
    expect(JSON.parse(stderr).error).toMatch(/unknown key bogus/);
  });

  test("the accepted keys are exactly the value-taking payload flags", async () => {
    const file = write("bad2.json", { bogus: "x" });
    const { stderr } = await runArgv(
      ["reference", "detail", "set", "keikka", "list", "--from-json", file],
      opts
    );
    const accepted = String(JSON.parse(stderr).error).split("accepted: ")[1];
    expect(accepted).toBe(
      "aiConfidence, append, detail, field, prepend, replace, summary, with"
    );
  });

  test.each(["needsHumanReview", "all"])(
    "the valueless boolean %s is NOT advertised as a JSON key",
    async (key) => {
      // fb#541: a valueless boolean cannot round-trip — `true` exits 4 ("must be
      // a string") and `"true"` is accepted and SILENTLY DROPPED. Loud rejection
      // is correct; both flags take no value, so argv carries them fine.
      const file = write(`${key}.json`, { [key]: true });
      const { exitCode, stderr } = await runArgv(
        ["reference", "detail", "set", "keikka", "list", "--from-json", file],
        opts
      );
      expect(exitCode).toBe(4);
      expect(JSON.parse(stderr).error).toMatch(new RegExp(`unknown key ${key}`));
    }
  );

  test("a wrong-typed value is rejected by name, not silently dropped", async () => {
    const file = write("wrongtype.json", { summary: { nested: true } });
    const { exitCode, stderr } = await runArgv(
      ["reference", "detail", "set", "keikka", "list", "--from-json", file],
      opts
    );
    expect(exitCode).toBe(4);
    expect(JSON.parse(stderr).error).toMatch(/"summary" must be a string/);
  });

  test("applies BEFORE the edit-mode guards, so a JSON-supplied SAME-FIELD conflict still fires", async () => {
    // Proves ordering: parseEditOp must see the merged options. If --from-json
    // were applied after, this would sail past the guard and PUT a mixed body.
    // --replace/--with default to --field detail, so --detail here targets the
    // SAME field (fb#1868) — unlike --summary, which would now be a disjoint
    // write and is allowed (covered in the "same-field-only" describe block below).
    const file = write("mixed.json", { replace: "x", with: "y", detail: "s" });
    const { exitCode, stderr } = await runArgv(
      ["reference", "detail", "set", "keikka", "list", "--from-json", file, "--reason", "t"],
      opts
    );
    expect(exitCode).toBe(4);
    expect(JSON.parse(stderr).error).toMatch(/cannot be combined with --detail/);
  });

  test("non-ASCII prose survives the file route intact", async () => {
    // The whole point: these characters are what argv mangles on PowerShell.
    const summary = "Ylijäämäbetonin vastaanottoasema — pää/sivu";
    const file = write("finnish.json", { summary, aiConfidence: 80 });
    const { exitCode, stderr } = await runArgv(
      ["reference", "detail", "set", "keikka", "list", "--from-json", file, "--reason", "t"],
      { ...opts, readOnly: true }
    );
    // The read-only lock refuses the PUT at the client, before any fetch — so
    // reaching it proves the payload parsed and merged rather than being
    // rejected as validation, and the assertion needs no network.
    expect(exitCode).toBe(3);
    expect(JSON.parse(stderr).code).toBe("READ_ONLY_BLOCKED");
  });
});

describe("ib reference detail set — same-field-only edit/overwrite validation (fb#1868)", () => {
  const opts = { token: "", endpoint: "https://example.invalid" };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("(a) --summary + --prepend (default --field detail) is a disjoint write — passes validation, no longer rejected", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ command: "ib keikka list", summary: "old summary", detail: "old detail", hint: "" }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
    );
    vi.stubGlobal("fetch", fetchMock);
    const { exitCode, stderr } = await runArgv(
      ["reference", "detail", "set", "keikka", "list", "--summary", "new summary", "--prepend", "PREFIX ", "--reason", "t"],
      opts
    );
    // Whatever this does downstream, it must not hit the old blanket guard.
    expect(stderr).not.toMatch(/cannot be combined with --/);
    expect(exitCode).toBe(0);
  });

  test("(b) --summary + --replace --field summary still FAILS with the same-field message", async () => {
    const { exitCode, stderr } = await runArgv(
      [
        "reference", "detail", "set", "keikka", "list",
        "--summary", "new summary", "--replace", "x", "--with", "y", "--field", "summary", "--reason", "t",
      ],
      opts
    );
    expect(exitCode).toBe(4);
    expect(JSON.parse(stderr).error).toMatch(/edit mode with --field summary cannot be combined with --summary/);
  });

  test("(c) --detail + --append (default --field detail) still FAILS with the same-field message", async () => {
    const { exitCode, stderr } = await runArgv(
      ["reference", "detail", "set", "keikka", "list", "--detail", "new detail", "--append", "more", "--reason", "t"],
      opts
    );
    expect(exitCode).toBe(4);
    expect(JSON.parse(stderr).error).toMatch(/edit mode with --field detail cannot be combined with --detail/);
  });
});
