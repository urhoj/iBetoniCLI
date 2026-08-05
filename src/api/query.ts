/**
 * Build a `?k=v&...` query suffix from defined params — the one idiom every
 * read command uses. `undefined` values are dropped (so an unset flag never
 * becomes the literal string "undefined"); everything else is `String()`-coerced
 * and URL-encoded by `URLSearchParams`. Key order follows insertion order, which
 * is part of the request the tests assert on. Returns `""` (not `"?"`) when no
 * param survived, so it can be appended to a path unconditionally.
 */
export function qs(
  params: Record<string, string | number | boolean | undefined>
): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) u.set(k, String(v));
  }
  const s = u.toString();
  return s ? `?${s}` : "";
}
