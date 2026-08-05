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