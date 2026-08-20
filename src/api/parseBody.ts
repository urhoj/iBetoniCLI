import { readFileSync } from "node:fs";
import { CliError, errorMessage } from "./errors.js";

/** Truncate a raw body so error output stays readable. */
function preview(raw: string): string {
  return raw.length > 160 ? `${raw.slice(0, 160)}…` : raw;
}

/**
 * Remedy hint for a failed `--body` parse. When the value has `{` but no `"`,
 * the double-quotes were almost certainly stripped by the shell (classic
 * Windows PowerShell behaviour, which eats inner `"` before Node sees the arg),
 * so point at the shell-safe escape hatches. Always echoes the raw value so the
 * caller can SEE what actually arrived.
 */
function bodyParseHint(raw: string): string {
  const base = `received: ${preview(raw)}`;
  const looksQuoteStripped = raw.includes("{") && !raw.includes('"');
  if (!looksQuoteStripped) return base;
  return (
    `${base}\nThe double-quotes are missing — a shell (e.g. Windows PowerShell) likely stripped them. ` +
    `Pass the JSON via --from-json <file|-> (a file, or - for stdin), wrap the whole value in single quotes, or run under Git Bash.`
  );
}

/**
 * Parse a `--body <json>` flag value into a plain object. A malformed body is
 * caller/validation input, so failures surface as a CliError mapped to exit 4
 * (validation) instead of the generic exit 1 a raw SyntaxError would produce.
 * The error carries a hint echoing the raw value and, when it looks
 * shell-mangled, how to pass JSON safely (see {@link bodyParseHint}).
 *
 * `statusCode` is **0** (client-origin), never a fabricated 400 — nothing was
 * sent. See {@link readJsonObjectInput} for why that matters (feedback #307).
 *
 * `flag` names the option in both messages, so the same parser serves the
 * `--data <json>` flags (`ib person notify`, `ib notification fcm send`)
 * without telling their caller to fix a `--body` they never passed.
 */
export function parseJsonBodyFlag(
  raw: string,
  flag = "--body"
): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    const detail = errorMessage(e);
    throw new CliError(`Invalid ${flag} JSON: ${detail}`, 0, null, 4, bodyParseHint(raw));
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new CliError(`${flag} must be a JSON object`, 0, null, 4, bodyParseHint(raw));
  }
  return parsed as Record<string, unknown>;
}

/**
 * The character offset a `JSON.parse` SyntaxError reports, if it named one.
 *
 * V8 emits TWO shapes and they are complementary — which is why the caller must
 * tolerate a null rather than treating it as a parsing bug:
 *   "Expected ',' or '}' … in JSON at position 19 (line 1 column 20)"
 *        → an offset, and NO excerpt of the document
 *   "Unexpected token ',', ...\":1,\"beta\":,\"gamma\"... is not valid JSON"
 *        → an excerpt V8 built itself, and no offset
 * So a null here means V8 already showed the caller the offending text, and
 * {@link offendingRegion} would only print it twice.
 */
function parseOffset(detail: string): number | null {
  const m = /at position (\d+)/.exec(detail);
  return m ? Number(m[1]) : null;
}

/**
 * Show the text AROUND the offset the parser choked on, with a caret. The
 * position alone is not actionable when the payload arrived mangled: the bytes
 * the CLI received are not the bytes the author typed, so "line 8 column 770"
 * describes a document the caller cannot see.
 */
function offendingRegion(raw: string, offset: number): string {
  const from = Math.max(0, offset - 30);
  const to = Math.min(raw.length, offset + 30);
  const slice = raw.slice(from, to).replace(/\n/g, "\\n");
  const caretAt = raw.slice(from, offset).replace(/\n/g, "\\n").length;
  return `  ${slice}\n  ${" ".repeat(caretAt)}^`;
}

/**
 * Remedy hint for a `--from-json` document that did not PARSE.
 *
 * Deliberately says what the failure is NOT: the generic `--from-json` spec row
 * covers four different failures (unreadable path, bad syntax, non-object root,
 * unknown key) and its remedy talks about the path and the key names. On a syntax
 * error the parser never reached a key, so that advice sends the caller off to
 * audit field names that are already correct — which is exactly what happened in
 * feedback #705.
 *
 * The backslash branch is the other half of that report, and it is measured, not
 * guessed: piping a heredoc into `-` on Windows Git Bash delivers BOTH `\\` and a
 * lone `\` to the process as ONE backslash, so an escaped backslash cannot be
 * expressed that way at all, while the same bytes in a real FILE survive intact.
 * `--from-json` is advertised as the shell-safe route, so when the payload holds a
 * backslash and did not parse, that is the likeliest cause and worth naming.
 */
function fromJsonParseHint(raw: string, detail: string): string {
  const offset = parseOffset(detail);
  const lines = [
    "The document is not valid JSON, so no field was read yet — this is NOT about the key names or the path.",
  ];
  if (offset !== null && offset <= raw.length) {
    lines.push("Received, around the reported offset:", offendingRegion(raw, offset));
  }
  if (/\\/.test(raw)) {
    lines.push(
      "It contains a backslash. If this came through a pipe (`--from-json -`), the shell may have " +
        "collapsed an escaped `\\\\` to a single `\\`, which JSON then reads as a bad escape — a heredoc " +
        "on Windows Git Bash does exactly that. Write the payload to a FILE and pass its path instead: " +
        "the bytes are then whatever the file holds."
    );
  }
  return lines.join("\n");
}

/** Read a file (or stdin when the path is `-`) as UTF-8, stripping a leading BOM. */
function readRawInput(pathOrDash: string): string {
  const raw = pathOrDash === "-" ? readFileSync(0, "utf8") : readFileSync(pathOrDash, "utf8");
  return raw.replace(/^\uFEFF/, "");
}

/**
 * Read and JSON-parse a file (or stdin when the path is `-`), returning whatever
 * shape the document holds — object OR array. The raw fs / `SyntaxError` is left
 * to escape: every caller wraps this in its own catch with a command-specific
 * message, so mapping the failure here would flatten those.
 * Use {@link readJsonObjectInput} when the value must be a JSON object.
 */
export function readJsonInput(path: string): unknown {
  return JSON.parse(readRawInput(path));
}

/**
 * Read a JSON object from a file path, or from stdin when the path is `-`.
 * Strips a leading BOM. This is the shell-safe alternative to inline `--body`
 * (a shell can strip its inner quotes), and mirrors `ib glossary import`'s
 * file/stdin pattern. Read/parse/shape failures all map to exit 4.
 *
 * These are LOCAL failures, so they carry `statusCode: 0` — the documented
 * client-origin marker — not a fabricated HTTP status. They used to throw 400,
 * which (a) told the caller the BACKEND rejected a request that was never sent,
 * (b) made `hintForError` skip the client-row matcher and serve an `http: 400`
 * row's remedy instead (a missing FILE answered with "check --type/--area/--date"
 * on `changelog add`), and (c) logged the same lie to the friction store.
 * Feedback #305/#307 — keep these at 0.
 */
export function readJsonObjectInput(pathOrDash: string): Record<string, unknown> {
  let raw: string;
  try {
    raw = readRawInput(pathOrDash);
  } catch (e) {
    const detail = errorMessage(e);
    // Each of the three failures below carries its OWN hint. They used to share
    // the command's generic `--from-json` spec row, whose remedy names the path
    // and the key names — right for this one and for an unknown key, wrong for a
    // syntax error and for a non-object root (feedback #705).
    const hint =
      pathOrDash === "-"
        ? "Nothing readable arrived on stdin. Pipe the JSON in (`… | ib … --from-json -`) or pass a file path instead of `-`."
        : "Could not open that path. Check it exists and is readable; the argument is a file path, or `-` to read stdin.";
    throw new CliError(`Could not read --from-json ${pathOrDash}: ${detail}`, 0, null, 4, hint);
  }
  // A distinct cause from a syntax error: the file WAS read, it just holds
  // nothing — commonly a stale 0-byte file from an earlier attempt, or a path
  // mismatch between whatever wrote it and the shell/CLI reading it (e.g. /tmp
  // resolving to two different directories on Windows/Git Bash). The syntax-error
  // hint below explicitly rules out "the path", which is exactly wrong here (fb#768).
  if (raw.trim() === "") {
    throw new CliError(
      `--from-json ${pathOrDash} is empty (0 bytes)`,
      0,
      null,
      4,
      "The file was read successfully but holds no content. Check you wrote to this exact path — a stale 0-byte file from an earlier attempt, or a tool resolving the same path string to a different location than the CLI (e.g. /tmp on Windows/Git Bash), are the common causes."
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    const detail = errorMessage(e);
    throw new CliError(
      `--from-json ${pathOrDash} (${raw.length} bytes) is not valid JSON: ${detail}`,
      0,
      null,
      4,
      fromJsonParseHint(raw, detail)
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    // Name what the root ACTUALLY was: "must contain a JSON object" alone leaves
    // the caller re-reading a document that is valid JSON, just the wrong shape.
    const got = Array.isArray(parsed) ? "an array" : parsed === null ? "null" : `a ${typeof parsed}`;
    throw new CliError(
      "--from-json must contain a JSON object",
      0,
      null,
      4,
      `The document parsed fine but its root is ${got}, not an object. Wrap the fields in { … }` +
        (Array.isArray(parsed) ? " — an array of entries is a different, per-command flag (e.g. `ib glossary import`)." : ".")
    );
  }
  return parsed as Record<string, unknown>;
}

/**
 * Resolve a JSON object body from either `--from-json` (file/stdin, shell-safe)
 * or an inline `--body` value. Exactly one may be supplied; both → exit 4.
 * When neither is set, returns null (the caller decides whether that is an
 * error — e.g. `person update` requires one, `person create` allows none).
 */
export function resolveJsonObjectBody(opts: {
  body?: string;
  fromJson?: string;
}): Record<string, unknown> | null {
  if (opts.fromJson !== undefined && opts.body !== undefined) {
    throw new CliError("--body and --from-json are mutually exclusive", 0, null, 4);
  }
  if (opts.fromJson !== undefined) return readJsonObjectInput(opts.fromJson);
  if (opts.body !== undefined) return parseJsonBodyFlag(opts.body);
  return null;
}
