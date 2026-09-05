import { describe, test, expect, vi } from "vitest";
import { cappedListEnvelope } from "../../src/api/envelopes.js";
import {
  warnIfLimitCapped,
  warnIfTruncated,
  warnIfCapReached,
  FEEDBACK_LIST_CAP,
  FEEDBACK_LIST_DEFAULT,
  CHANGELOG_LIST_CAP,
} from "../../src/api/listCaps.js";

/**
 * fb#605. Both list routes clamp `limit` server-side and answer with a BARE
 * ARRAY, so the clamp was invisible: `--limit 1000` returned 200 rows with no
 * `truncated`, no cursor and no hint.
 *
 * The near-miss that found it: a sweep over every cliFeedback row read 200 of
 * 604 and looked complete. Trusting it would have produced a confident "all
 * prose-only links repaired" claim over a third of the data.
 */
const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ id: i }));

describe("cappedListEnvelope", () => {
  test("THE BUG: asking above the cap and receiving a capped page is truncated", () => {
    // items.length (200) never equals the raw request (1000), which is exactly
    // why the naive `items.length >= requested` rule missed this.
    const env = cappedListEnvelope(rows(200), {
      requested: 1000,
      serverCap: FEEDBACK_LIST_CAP,
      serverDefault: FEEDBACK_LIST_DEFAULT,
    });
    expect(env.truncated).toBe(true);
    expect(env.count).toBe(200);
  });

  test("a full page at the requested limit is truncated — there may be more", () => {
    const env = cappedListEnvelope(rows(50), {
      requested: 50,
      serverCap: FEEDBACK_LIST_CAP,
      serverDefault: FEEDBACK_LIST_DEFAULT,
    });
    expect(env.truncated).toBe(true);
  });

  test("a short page is NOT truncated — the common case stays quiet", () => {
    const env = cappedListEnvelope(rows(7), {
      requested: 50,
      serverCap: FEEDBACK_LIST_CAP,
      serverDefault: FEEDBACK_LIST_DEFAULT,
    });
    expect(env.truncated).toBeUndefined();
  });

  test("with no --limit it reasons about the server DEFAULT, not the cap", () => {
    // A default-sized full page is still a capped page; comparing against the
    // cap (200) instead of the default (50) would call it complete.
    const env = cappedListEnvelope(rows(50), {
      requested: undefined,
      serverCap: FEEDBACK_LIST_CAP,
      serverDefault: FEEDBACK_LIST_DEFAULT,
    });
    expect(env.truncated).toBe(true);
  });

  test("the backend header WINS over the client-side guess", () => {
    // Authoritative, and immune to the mirrored constants drifting.
    const env = cappedListEnvelope(rows(3), {
      requested: 500,
      serverCap: CHANGELOG_LIST_CAP,
      serverDefault: 100,
      meta: { truncated: true },
    });
    expect(env.truncated).toBe(true);
  });

  test("a non-array body yields an empty, untruncated envelope rather than throwing", () => {
    const env = cappedListEnvelope(null, { requested: 10, serverCap: 200, serverDefault: 50 });
    expect(env.items).toEqual([]);
    expect(env.truncated).toBeUndefined();
  });

  test("key order stays items, nextCursor, count, truncated", () => {
    // stdout key order is part of the observable contract.
    const env = cappedListEnvelope(rows(50), { requested: 50, serverCap: 200, serverDefault: 50 });
    expect(Object.keys(env)).toEqual(["items", "nextCursor", "count", "truncated"]);
  });
});

describe("warnIfLimitCapped", () => {
  test("warns when the request exceeds the cap, naming --offset as the way out", () => {
    const warn = vi.fn();
    warnIfLimitCapped(1000, FEEDBACK_LIST_CAP, "ib dev feedback list", warn);
    expect(warn).toHaveBeenCalledTimes(1);
    const msg = warn.mock.calls[0][0] as string;
    expect(msg).toContain("exceeds this route's maximum of 200");
    expect(msg).toContain("NOT the whole table");
    expect(msg).toContain("ib dev feedback list --offset 200");
  });

  test("stays silent at or below the cap, and when no --limit was given", () => {
    const warn = vi.fn();
    warnIfLimitCapped(200, FEEDBACK_LIST_CAP, "x", warn);
    warnIfLimitCapped(5, FEEDBACK_LIST_CAP, "x", warn);
    warnIfLimitCapped(undefined, FEEDBACK_LIST_CAP, "x", warn);
    warnIfLimitCapped("abc", FEEDBACK_LIST_CAP, "x", warn);
    expect(warn).not.toHaveBeenCalled();
  });
});

/**
 * fb#641. The other direction: the caller asked for nothing in particular and
 * the DEFAULT cap bit. The payload has carried `truncated`/`hint` since fb#606
 * and it changed nothing, because a caller who does not check `truncated` also
 * does not raise `--limit` — `ib dev schema procs` answered with 200 of 535
 * procs, exit 0, and the index built from it "proved" whole families of procs
 * did not exist.
 */
describe("warnIfTruncated", () => {
  test("THE BUG: a truncated page is announced on stderr, not just in the payload", () => {
    const warn = vi.fn();
    warnIfTruncated(
      { count: 200, truncated: true, hint: "capped at 200 rows — re-run with --limit 1000" },
      "ib dev schema procs",
      warn
    );
    expect(warn).toHaveBeenCalledTimes(1);
    const msg = warn.mock.calls[0][0] as string;
    expect(msg).toContain("ib dev schema procs");
    expect(msg).toContain("TRUNCATED");
    expect(msg).toContain("200");
    // The conclusion the reported failure actually reached.
    expect(msg).toContain("no such object exists");
  });

  test("prefers the backend's hint, so a server-side cap change cannot go stale here", () => {
    const warn = vi.fn();
    warnIfTruncated({ count: 200, truncated: true, hint: "re-run with --limit 4000" }, "cmd", warn);
    expect(warn.mock.calls[0][0]).toContain("--limit 4000");
  });

  test("falls back to generic advice when the backend sends no hint", () => {
    const warn = vi.fn();
    warnIfTruncated({ count: 200, truncated: true }, "cmd", warn);
    expect(warn.mock.calls[0][0]).toContain("--limit");
  });

  test("stays silent on a complete page — the common case adds no noise", () => {
    const warn = vi.fn();
    warnIfTruncated({ count: 12, truncated: false }, "cmd", warn);
    warnIfTruncated({ count: 12 }, "cmd", warn);
    warnIfTruncated(null, "cmd", warn);
    warnIfTruncated(undefined, "cmd", warn);
    expect(warn).not.toHaveBeenCalled();
  });
});

/**
 * fb#1439 — a page capped AT the maximum warned nothing.
 *
 * `warnIfLimitCapped` fires only when the caller ASKED for more than the cap
 * (`if (n <= cap) return`), so `--limit 200` against 234 rows was silent while
 * `--limit 250` got the loud, correct advice. The default limit makes it worse:
 * the common case passes no limit at all and hits the same silence at 50.
 *
 * Not covered by `warnIfTruncated`, and reusing it here would be wrong twice
 * over: its remedy is "re-run with a higher --limit", which cannot work at a
 * HARD cap (only --offset reaches the rest), and it prefers `env.hint`, which on
 * `feedback list` describes TEXT elision ("description/resolution over 200 chars
 * show head+tail") — attaching that to a missing-ROWS warning is worse than
 * silence, because it reads like an explanation.
 *
 * Real cost: scripts/audit-feedback-shipped.js (fb#1435) shipped scanning 200 of
 * 234 rows. Because `--unresolved` merges newest-first then slices, the rows it
 * lost were the OLDEST — exactly what an "already fixed and forgotten" audit is
 * looking for. It missed fb#345 until the truncation was found by hand.
 */
describe("warnIfCapReached (fb#1439)", () => {
  test("THE BUG: a page capped AT the maximum is announced, though nothing over-asked", () => {
    const warn = vi.fn();
    warnIfCapReached({ count: 200, truncated: true }, { effective: 200, cap: FEEDBACK_LIST_CAP, command: "ib dev feedback list" }, warn);
    expect(warn).toHaveBeenCalledTimes(1);
    const msg = warn.mock.calls[0][0] as string;
    expect(msg).toContain("ib dev feedback list");
    expect(msg).toContain("200");
    // The only remedy that actually reaches the rest of a hard-capped route.
    expect(msg).toContain("--offset 200");
  });

  test("must NOT reuse a text-elision hint as the reason rows are missing", () => {
    // This is the misdirection half of the report: `feedback list` puts a
    // TEXT-truncation hint in env.hint while env.truncated means ROWS, so a
    // caller who checks `truncated` and reads `hint` is told about elided prose.
    const warn = vi.fn();
    warnIfCapReached(
      {
        count: 200,
        truncated: true,
        hint: "description/resolution/errorText over 200 chars show head+tail (middle elided)",
      },
      { effective: 200, cap: FEEDBACK_LIST_CAP, command: "ib dev feedback list" },
      warn
    );
    const msg = warn.mock.calls[0][0] as string;
    expect(msg).not.toContain("head+tail");
    expect(msg).not.toContain("elided");
    expect(msg).toContain("--offset");
  });

  test("stays silent on a complete page — the common case adds no noise", () => {
    const warn = vi.fn();
    warnIfCapReached({ count: 12, truncated: undefined }, { effective: 200, cap: FEEDBACK_LIST_CAP, command: "cmd" }, warn);
    warnIfCapReached({ count: 12 }, { effective: 200, cap: FEEDBACK_LIST_CAP, command: "cmd" }, warn);
    warnIfCapReached(null, { effective: 200, cap: FEEDBACK_LIST_CAP, command: "cmd" }, warn);
    warnIfCapReached(undefined, { effective: 200, cap: FEEDBACK_LIST_CAP, command: "cmd" }, warn);
    expect(warn).not.toHaveBeenCalled();
  });

test("a full page BELOW the cap blames the caller's own --limit, not the route maximum", () => {
    // Caught in end-to-end review before shipping: the first cut attributed every
    // truncated page to the hard cap, so `--limit 5` was told to use `--offset 200`
    // and that "raising --limit will not help" — when raising it is precisely the fix.
    // A confidently wrong remedy is the exact defect class this warning exists to fix.
    const warn = vi.fn();
    warnIfCapReached(
      { count: 5, truncated: true },
      { effective: 5, cap: FEEDBACK_LIST_CAP, command: "ib dev feedback list" },
      warn
    );
    const msg = warn.mock.calls[0][0] as string;
    expect(msg).toContain("--limit 5");
    expect(msg).toContain("--offset 5");
    expect(msg).toContain("up to 200");
    expect(msg).not.toContain("hard cap");
    expect(msg).not.toContain("--offset 200");
  });

  test("the default page size counts as the caller's limit, not the cap", () => {
    // The commonest shape of all: no --limit at all, 50 rows back, more behind them.
    const warn = vi.fn();
    warnIfCapReached(
      { count: 50, truncated: true },
      { effective: FEEDBACK_LIST_DEFAULT, cap: FEEDBACK_LIST_CAP, command: "ib dev feedback list" },
      warn
    );
    expect(warn.mock.calls[0][0]).toContain("--offset 50");
  });

  test("names the route's own cap, so changelog and feedback advise different offsets", () => {
    const warn = vi.fn();
    warnIfCapReached({ count: 500, truncated: true }, { effective: 500, cap: CHANGELOG_LIST_CAP, command: "ib dev changelog list" }, warn);
    expect(warn.mock.calls[0][0]).toContain("--offset 500");
  });
});
