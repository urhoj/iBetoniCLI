/**
 * In-field partial edits for the long-text commands (ib legal save / ohje update /
 * reference detail set). One pure helper applies a single edit operation to a
 * field's current value; the commands wrap it in a client-side read-merge-write.
 * Generalises the glossary append/replace idea to markdown/HTML bodies.
 * Spec: docs/superpowers/specs/2026-06-24-ib-in-field-partial-edits-design.md
 */
import { failWith } from "./output/json.js";

export type TextEditOp =
  | { kind: "replace"; find: string; replacement: string; all?: boolean }
  | { kind: "append"; text: string }
  | { kind: "prepend"; text: string };

export interface TextEditResult {
  next: string;
  /** Number of occurrences substituted (replace only; absent for append/prepend). */
  matchCount?: number;
}

/** Raw edit flags an edit-capable command exposes (Commander camelCases them). */
export interface EditFlags {
  replace?: string;
  with?: string;
  append?: string;
  prepend?: string;
  all?: boolean;
}

/** Count non-overlapping occurrences of a literal `needle` in `haystack`. */
function countOccurrences(haystack: string, needle: string): number {
  if (needle === "") return 0;
  let count = 0;
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    count++;
    i = haystack.indexOf(needle, i + needle.length);
  }
  return count;
}

/**
 * Apply one in-field edit, returning the new field value. `current` is coerced
 * from null/undefined to "". Throws failWith(exit 4) when a replace breaks the
 * strict match rule (0 matches; >1 and not `all`). append/prepend insert the
 * given text VERBATIM (no separator — the caller controls whitespace).
 */
export function applyTextEdit(current: string, op: TextEditOp): TextEditResult {
  const base = current ?? "";
  switch (op.kind) {
    case "append":
      return { next: base + op.text };
    case "prepend":
      return { next: op.text + base };
    case "replace": {
      const n = countOccurrences(base, op.find);
      if (n === 0) failWith("--replace search text not found in the current field", 4);
      if (n > 1 && !op.all) {
        failWith(`--replace matched ${n} times; pass --all or narrow the search`, 4);
      }
      return { next: base.split(op.find).join(op.replacement), matchCount: n };
    }
  }
}

/**
 * Map raw edit flags → at most one TextEditOp. Returns undefined when no edit
 * flag is present (the command falls back to its existing whole-body behaviour).
 * Enforces: at most one of --replace/--append/--prepend; --with required iff
 * --replace; --with/--all without --replace → exit 4.
 */
export function parseEditOp(flags: EditFlags): TextEditOp | undefined {
  const kinds: Array<"replace" | "append" | "prepend"> = [];
  if (flags.replace !== undefined) kinds.push("replace");
  if (flags.append !== undefined) kinds.push("append");
  if (flags.prepend !== undefined) kinds.push("prepend");

  if (kinds.length === 0) {
    if (flags.with !== undefined) failWith("--with requires --replace", 4);
    if (flags.all) failWith("--all only applies with --replace", 4);
    return undefined;
  }
  if (kinds.length > 1) {
    failWith(`pass only one of --replace / --append / --prepend (got ${kinds.join(", ")})`, 4);
  }
  if (flags.replace !== undefined) {
    if (flags.with === undefined) {
      failWith('--replace requires --with <text> (use --with "" to delete the match)', 4);
    }
    return { kind: "replace", find: flags.replace, replacement: flags.with, all: !!flags.all };
  }
  if (flags.all) failWith("--all only applies with --replace", 4);
  if (flags.append !== undefined) return { kind: "append", text: flags.append };
  return { kind: "prepend", text: flags.prepend! };
}
