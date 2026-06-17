/**
 * Client-side validation for `ib legal save --validate-json` (CLI usability #2).
 *
 * The betonijerry structured legal types (BETONIJERRY_REQUEST_CONSENT /
 * BETONIJERRY_OFFER_ACCEPTANCE) store their copy as a fenced ```json block in
 * markdownContent. A malformed block ACTIVATES SILENTLY — the FE just falls back
 * to bundled copy (parseStructuredDoc returns the fallback ref), so a broken
 * save is invisible until someone notices the live copy is wrong. This validates
 * the block parses BEFORE the save, so a broken payload can never go live.
 *
 * Extraction mirrors the FE (betonijerry src/utils/legal/acceptanceCopy.js
 * parseStructuredDoc) EXACTLY — same regex — so the CLI validates precisely what
 * the FE will attempt to parse. The CLI cannot know the per-type KEY shape (the
 * FE owns that and falls back safely on mismatch), so the shape check here is
 * generic: the payload must parse AND be a non-null, non-array JSON object.
 */
export interface JsonValidationResult {
  ok: boolean;
  error?: string;
}

/** The JSON candidate string: the first ```json fence if present, else the whole content. */
export function extractJsonCandidate(markdownContent: string): string {
  const fenced = markdownContent.match(/```json\s*([\s\S]*?)```/i);
  return (fenced ? fenced[1] : markdownContent).trim();
}

export function validateStructuredJson(markdownContent: string): JsonValidationResult {
  if (typeof markdownContent !== "string" || !markdownContent.trim()) {
    return { ok: false, error: "content is empty — nothing to validate" };
  }
  const raw = extractJsonCandidate(markdownContent);
  if (!raw) {
    return { ok: false, error: "no ```json block found and content is not JSON" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { ok: false, error: `JSON does not parse: ${(e as Error).message}` };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "JSON must be an object (the FE reads it as a key/value map)" };
  }
  return { ok: true };
}
