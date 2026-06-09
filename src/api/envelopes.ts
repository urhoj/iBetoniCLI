export interface ListEnvelope<T> {
  items: T[];
  nextCursor: string | null;
  count: number;
  /** True when the backend signalled the page was capped (more rows exist). */
  truncated?: boolean;
}

export function isListEnvelope(value: unknown): value is ListEnvelope<unknown> {
  return (
    !!value &&
    typeof value === "object" &&
    Array.isArray((value as { items?: unknown }).items)
  );
}

/**
 * Normalise a backend response that may be a bare array OR a raw mssql result
 * wrapper ({ recordset } / { recordsets: [[...]] }) into a flat array of row
 * objects. Returns [] for null/unrecognised shapes.
 */
export function unwrapRows(raw: unknown): Record<string, unknown>[] {
  if (Array.isArray(raw)) return raw as Record<string, unknown>[];
  if (raw && typeof raw === "object") {
    const obj = raw as { recordset?: unknown; recordsets?: unknown };
    if (Array.isArray(obj.recordset)) {
      return obj.recordset as Record<string, unknown>[];
    }
    if (Array.isArray(obj.recordsets) && Array.isArray(obj.recordsets[0])) {
      return obj.recordsets[0] as Record<string, unknown>[];
    }
  }
  return [];
}
