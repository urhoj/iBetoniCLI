import { describe, test, expect, vi } from "vitest";
import { cappedListEnvelope } from "../../src/api/envelopes.js";
import {
  warnIfLimitCapped,
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
