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
