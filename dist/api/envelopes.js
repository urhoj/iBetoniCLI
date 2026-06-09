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