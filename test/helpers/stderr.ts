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
   * CONTENT: a diagnostic split across two `write()` calls is one message, and
   * matching per-chunk would miss it.
   */
  text: () => string;
  /** Restore the real stream. Always call this — usually from `afterEach`. */
  restore: () => void;
};

/**
 * Spy on `process.stderr.write`, collecting what was written.
 *
 * Silences the stream for the duration, so a test that only needs quiet can
 * capture and ignore the result. `lines()` being empty is the replacement for
 * asserting `not.toHaveBeenCalled()` on a bare spy.
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
 * Shared by `--print-payload` (`[ib] payload · …`) and the `--stats` line, which
 * both encode a JSON body after a `·` separator. Returns `null` when no such
 * line was written, so a caller can assert absence without a throw; callers that
 * REQUIRE the line should assert on the result themselves rather than have this
 * helper own the expectation.
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
