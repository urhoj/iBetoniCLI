/**
 * Build the canonical list envelope. Key order is `items, nextCursor, count`
 * then the optional `truncated`/`hint` — stdout JSON key order is part of the
 * observable contract, so the optional keys are APPENDED (only when supplied)
 * rather than always present as `undefined`.
 */
export function listEnvelope(items, extra) {
    const env = {
        items,
        nextCursor: extra?.nextCursor ?? null,
        count: items.length,
    };
    if (extra?.truncated !== undefined)
        env.truncated = extra.truncated;
    if (extra?.hint !== undefined)
        env.hint = extra.hint;
    return env;
}
/**
 * Wrap a backend response that is expected to be a bare ARRAY into the envelope.
 * Non-`/api/cli/` routes (BetoniJerry, messages, ilmoitustaulu) send raw data
 * via `sendSuccess`, so the CLI projects them client-side. Defensive: any
 * non-array body (null, an error object) yields an empty envelope rather than
 * throwing.
 */
/**
 * Wrap a bare-array response from a route that CAPS its row count, and report
 * the cap honestly (fb#605).
 *
 * The failure this exists to prevent: `--limit 1000` against a route capped at
 * 200 returned 200 rows with no `truncated`, no cursor and no hint. A sweep over
 * every feedback row therefore looked complete at 200 of 604 — the newest fifth
 * — and would have produced a confident "all links repaired" claim over a third
 * of the data.
 *
 * Two sources, in order:
 *  1. `meta` from the backend's X-Result-* headers — authoritative, and immune
 *     to the caps drifting.
 *  2. A client-side fallback for a backend predating those headers: a FULL page
 *     means there may be more. `serverCap` mirrors the backend constant, so the
 *     effective limit is min(requested, cap) rather than the raw request — which
 *     is the whole point, since asking for 1000 and receiving 200 is exactly the
 *     case the naive `items.length >= requested` rule misses.
 *
 * Over-reporting on an exact boundary is the deliberate direction: one wasted
 * page beats silently losing rows.
 */
export function cappedListEnvelope(raw, opts) {
    const items = Array.isArray(raw) ? raw : [];
    const requested = Number(opts.requested);
    const asked = Number.isFinite(requested) && requested > 0 ? requested : opts.serverDefault;
    const effective = Math.min(asked, opts.serverCap);
    const truncated = opts.meta?.truncated === true || items.length >= effective;
    return listEnvelope(items, truncated ? { truncated: true } : undefined);
}
export function toListEnvelope(raw) {
    const items = Array.isArray(raw) ? raw : [];
    return listEnvelope(items);
}
export function isListEnvelope(value) {
    return (!!value &&
        typeof value === "object" &&
        Array.isArray(value.items));
}
/**
 * Normalise a backend response that may be a bare array OR a raw mssql result
 * wrapper ({ recordset } / { recordsets: [[...]] }) into a flat array of row
 * objects. Returns [] for null/unrecognised shapes.
 */
export function unwrapRows(raw) {
    if (Array.isArray(raw))
        return raw;
    if (raw && typeof raw === "object") {
        const obj = raw;
        if (Array.isArray(obj.recordset)) {
            return obj.recordset;
        }
        if (Array.isArray(obj.recordsets) && Array.isArray(obj.recordsets[0])) {
            return obj.recordsets[0];
        }
    }
    return [];
}
//# sourceMappingURL=envelopes.js.map