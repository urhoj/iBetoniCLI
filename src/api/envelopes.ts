export interface ListEnvelope<T> {
  items: T[];
  nextCursor: string | null;
  count: number;
}

export function isListEnvelope(value: unknown): value is ListEnvelope<unknown> {
  return (
    !!value &&
    typeof value === "object" &&
    Array.isArray((value as { items?: unknown }).items)
  );
}
