import { vi } from "vitest";

/**
 * Shared `process.stderr.write` capture.
 *
 * Before this existed, the `vi.spyOn(process.stderr, "write")` + local array +
 * beforeEach/afterEach scaffold was hand-rolled in ~18 test files — the same
 * shape, and the same argument, that already justified {@link mockApiClient}
 * (whose own doc records ~70 files before IT was extracted).
 *
 * The stakes here are higher than tidiness. "stdout is JSON, always; stderr
 * carries diagnostics" is a CORE contract of this CLI, and every test asserting
 * it re-implemented its own capture. A subtly wrong local one — a missing
 * `afterEach` restore, the wrong stream, a multi-chunk write read as a single
 * line — would quietly weaken that guarantee in ONE file while the other
 * seventeen stayed strict, and nothing would fail. One implementation means one
 * place to be right.
 *
 * Deliberately NOT auto-restoring via a global `afterEach`: a helper that
 * registers hooks only works at describe scope, and several call sites capture
 * inside a single `test`. `restore()` stays explicit, exactly as the hand-rolled
 * copies had it.
 */
export type StderrCapture = {
  /** One entry per `write()` call, in order. */
  lines: () => string[];
  /**
   * Every chunk joined. Prefer this over `lines()` when asserting on message
   * CONTENT: a substring can span two SEPARATE diagnostics, and per-line
   * matching would miss it. That is what the still-hand-rolled files already do
   * by hand — `written.join("")` in test/parse-errors.test.ts,
   * test/commands/feedback.test.ts and test/commands/feedbackClaim.test.ts —
   * so `text()` is that idiom spelled once.
   *
   * (No diagnostic is currently split ACROSS `write()` calls; every emitter
   * builds one complete string and writes it in a single call. The reason to
   * prefer `text()` is the cross-message search above, not chunk reassembly.)
   */
  text: () => string;
  /** Restore the real stream. Always call this — usually from `afterEach`. */
  restore: () => void;
};

/**
 * Spy on `process.stderr.write`, collecting what was written.
 *
 * Silences the stream for the duration, so a test that only needs quiet can
 * capture and ignore the result.
 *
 * ⚠ MIGRATING A HAND-ROLLED CAPTURE IS NOT ALWAYS A STRAIGHT SWAP. This returns
 * a plain object, not a `Mock`, so the spy matchers some files use — e.g.
 * `expect(stderrSpy).not.toHaveBeenCalled()` in test/program-embedded.test.ts
 * and test/embedded-context.test.ts, and `toHaveBeenCalledTimes(1)` in
 * test/api/client.test.ts — will THROW here ("received value must be a mock or
 * spy function") rather than fail cleanly. Translate those to
 * `expect(cap.lines()).toHaveLength(0)` / `toHaveLength(1)`.
 */
export function captureStderr(): StderrCapture {
  const written: string[] = [];
  const spy = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    });
  return {
    lines: () => written,
    text: () => written.join(""),
    restore: () => spy.mockRestore(),
  };
}

/**
 * Parse the `[ib] <name> · {json}` diagnostic shape back into an object.
 *
 * Today that shape has exactly ONE emitter: `--print-payload`
 * (`[ib] payload · {…}`, src/api/client.ts). Do not reach for this with
 * `"stats"` — the `--stats` line does NOT use this shape in either mode:
 * `--pretty` emits human prose after a COLON (`[ib] stats: api=120ms …`,
 * src/stats.ts `buildStatsLine`) and JSON mode emits a bare `{"stats":{…}}`
 * with no `[ib]` prefix at all. `parseDiagnostic(cap, "stats")` would therefore
 * return `null` forever, which is a silent nothing rather than a failure —
 * assert on `cap.text()` for the pretty line, or `JSON.parse(cap.text())` for
 * the JSON one.
 *
 * Returns `null` when no matching line was written, so a caller can assert
 * absence without a throw; callers that REQUIRE the line should assert on the
 * result themselves rather than have this helper own the expectation.
 */
export function parseDiagnostic(
  cap: StderrCapture,
  name: string
): Record<string, unknown> | null {
  const marker = `[ib] ${name} · `;
  const line = cap.lines().find((l) => l.includes(marker));
  if (!line) return null;
  return JSON.parse(line.slice(line.indexOf(marker) + marker.length)) as Record<
    string,
    unknown
  >;
}

/**
 * Run a parse whose in-action guard fails, and return what the CALLER sees:
 * the JSON error envelope on stderr plus the mapped exit code. `process.exitCode`
 * is saved/restored so a guard assertion never leaks into the runner's own exit
 * code (fb#729 — this was hand-rolled identically in three test files; `cap.text()`
 * is an exact drop-in for the old `chunks.join("")`).
 *
 * NOTE: this parses the WHOLE stderr capture as one JSON error envelope, which
 * is a DIFFERENT shape from {@link parseDiagnostic}'s `[ib] <name> · {json}`
 * diagnostic lines — do not reach for `parseDiagnostic` here.
 */
export async function captureActionError(
  run: () => Promise<unknown>
): Promise<{ exitCode: number | undefined; envelope: Record<string, unknown> }> {
  const prevExit = process.exitCode;
  process.exitCode = undefined;
  const cap = captureStderr();
  try {
    await run();
    return {
      exitCode: process.exitCode as number | undefined,
      envelope: JSON.parse(cap.text()) as Record<string, unknown>,
    };
  } finally {
    cap.restore();
    process.exitCode = prevExit;
  }
}
