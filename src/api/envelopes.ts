export interface ListEnvelope<T> {
  items: T[];
  nextCursor: string | null;
  count: number;
  /** True when the backend signalled the page was capped (more rows exist). */
  truncated?: boolean;
  /** Next-step pointer for an AI reader (e.g. a wider scope that may match). */
  hint?: string;
}

/**
 * Build the canonical list envelope. Key order is `items, nextCursor, count`
 * then the optional `truncated`/`hint` — stdout JSON key order is part of the
 * observable contract, so the optional keys are APPENDED (only when supplied)
 * rather than always present as `undefined`.
 */
export function listEnvelope<T>(
  items: T[],
  extra?: { nextCursor?: string | null; truncated?: boolean; hint?: string }
): ListEnvelope<T> {
  const env: ListEnvelope<T> = {
    items,
    nextCursor: extra?.nextCursor ?? null,
    count: items.length,
  };
  if (extra?.truncated !== undefined) env.truncated = extra.truncated;
  if (extra?.hint !== undefined) env.hint = extra.hint;
  return env;
}

/**
 * Wrap a backend response that is expected to be a bare ARRAY into the envelope.
 * Non-`/api/cli/` routes (BetoniJerry, messages, ilmoitustaulu) send raw data
 * via `sendSuccess`, so the CLI projects them client-side. Defensive: any
 * non-array body (null, an error object) yields an empty envelope rather than
 * throwing.
 */
export function toListEnvelope<T>(raw: unknown): ListEnvelope<T> {
  const items = Array.isArray(raw) ? (raw as T[]) : [];
  return listEnvelope(items);
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
