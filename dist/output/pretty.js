import { createRequire } from "node:module";
// BOTH pretty-mode deps are lazy-required: they are only reachable via --pretty,
// but output/json.ts imports this module, so a static import would load them on
// 100% of invocations. Measured cost of loading them eagerly: cli-table3 ~14 ms,
// chalk ~11 ms — chalk is NOT negligible (an earlier comment here claimed it was
// and kept it static). chalk 6 is ESM-only, which `require()` handles from Node
// 22.12 on; the engines floor (^22.18 || >=24.11) clears that, so both stay
// synchronous and the render functions below need not become async.
// The `createRequire` handle is lazy for the same reason as its two consumers.
let _require = null;
function cjsRequire() {
    return (_require ??= createRequire(import.meta.url));
}
let _Table = null;
function tableCtor() {
    return (_Table ??= cjsRequire()("cli-table3"));
}
let _chalk = null;
/** Lazily-resolved chalk instance. `require()` of an ESM module yields a
 *  namespace object, so unwrap `.default`. */
function chalk() {
    if (_chalk)
        return _chalk;
    const mod = cjsRequire()("chalk");
    return (_chalk = mod.default ?? mod);
}
/** cli-table3 colWidth includes the 2 padding spaces; 6 leaves 4 visible chars. */
const MIN_COL_WIDTH = 6;
/** Used when stdout is not a TTY (piped/captured) — columns is undefined there. */
const DEFAULT_TERM_WIDTH = 100;
function terminalWidth() {
    return process.stdout.columns || DEFAULT_TERM_WIDTH;
}
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b\[\d+(?:;\d+)*m/g;
/** Longest visible line of a (possibly multi-line, possibly colored) cell. */
function visibleWidth(cell) {
    return Math.max(...cell.replace(ANSI_RE, "").split("\n").map((line) => line.length));
}
/** Below this per-column width a capped table stops being readable. */
const READABLE_COL_WIDTH = 12;
/** Marks a list cell (or folded value) that was cut to fit. */
const ELLIPSIS = "…";
/** Cell text without its colour escapes — for measuring and for slicing. */
const plain = (cell) => cell.replace(ANSI_RE, "");
function availableWidth(n) {
    const borders = n + 1;
    return Math.max(terminalWidth(), n * MIN_COL_WIDTH + borders) - borders;
}
/**
 * Fit columns into the terminal (feedback #34: --pretty must never emit a
 * table wider than the terminal). `natural` is the per-column max content
 * width. Returns cli-table3 `colWidths` (content + 2 padding), or null when
 * the natural widths already fit (no constraint needed). Water-filling: caps
 * the widest column(s) so narrow id/date columns keep their full width.
 */
function fitColumns(natural) {
    const n = natural.length;
    const available = availableWidth(n);
    const widths = natural.map((w) => w + 2);
    const sumCapped = (cap) => widths.reduce((a, w) => a + Math.min(w, cap), 0);
    if (sumCapped(Number.MAX_SAFE_INTEGER) <= available)
        return null;
    // largest cap T (≥ minimum) with sum(min(w, T)) <= available
    let lo = MIN_COL_WIDTH;
    let hi = Math.max(...widths);
    while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (sumCapped(mid) <= available)
            lo = mid;
        else
            hi = mid - 1;
    }
    const fitted = widths.map((w) => Math.min(w, lo));
    // hand any leftover space to the capped columns, one char per round
    let slack = available - fitted.reduce((a, b) => a + b, 0);
    while (slack > 0) {
        const i = fitted.findIndex((f, j) => f < widths[j]);
        if (i === -1)
            break;
        fitted[i]++;
        slack--;
    }
    return fitted;
}
/**
 * Table options for constrained tables. wrapOnWordBoundary:false hard-wraps at
 * the column width — cli-table3's word-boundary mode TRUNCATES tokens longer
 * than the column (e.g. JSON blobs) with "…", which loses data.
 */
function fittedOptions(natural) {
    const colWidths = fitColumns(natural);
    return colWidths ? { colWidths, wordWrap: true, wrapOnWordBoundary: false } : {};
}
/** First line of a (possibly multi-line) cell, marked when lines were dropped. */
function firstLine(cell) {
    const nl = cell.indexOf("\n");
    return nl === -1 ? cell : cell.slice(0, nl) + ELLIPSIS;
}
/** Cut a single-line cell to `max` visible chars, marking the loss. */
function clampCell(cell, max) {
    if (visibleWidth(cell) <= max)
        return cell;
    return max <= 1 ? ELLIPSIS : plain(cell).slice(0, max - 1) + ELLIPSIS;
}
/**
 * Columns whose value never changes across the whole result set — including
 * all-null ones. They are folded OUT of the table and reported once above it,
 * so nothing is lost while the table wins its width back (an 18-column
 * `ib dev feedback list` sheds 5 columns this way — feedback #341).
 *
 * Skipped for a 1-row list, where EVERY column is trivially "constant" and
 * folding would leave an empty table. The first column is never folded: it is
 * the row's identity anchor, and a table with no columns renders as nothing.
 */
function constantColumns(headers, items) {
    if (items.length < 2)
        return [];
    const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
    return headers.filter((h, i) => i > 0 && items.every((r) => same(r[h], items[0][h])));
}
/** How many columns can still hold {@link READABLE_COL_WIDTH} chars each. */
function readableColumnCount(n) {
    let k = n;
    while (k > 1 && k * READABLE_COL_WIDTH > availableWidth(k))
        k--;
    return k;
}
export function renderList(envelope, columns) {
    // Guard on the actual array, not `count`: a backend page can report a
    // non-zero/absent `count` (total-count semantics, or an out-of-range cursor)
    // while `items` is empty — trusting `count` here would deref items[0] and
    // crash pretty mode with a raw TypeError.
    if (envelope.items.length === 0)
        return chalk().dim("(no results)");
    const items = envelope.items;
    // A 1-row list is really a record: keep every column and every character
    // (the hard-wrap below loses nothing). Only a MULTI-row list is a table that
    // has to stay one line per record to be scannable.
    const multi = items.length > 1;
    const folded = constantColumns(Object.keys(items[0]), items);
    let headers = Object.keys(items[0]).filter((h) => !folded.includes(h));
    // An explicit selection (a spec's `prettyColumns`, or the global --columns)
    // wins over the automatic fit — the caller has already said which columns
    // matter, and `fitColumns` still guarantees the terminal is never exceeded.
    // Automatic fallback is leftmost-fits: deliberately dumb and predictable,
    // with every dropped column named in the footer, because no column-order-
    // agnostic ranking picks the right subset across every domain's row shape.
    const wanted = columns?.filter((c) => headers.includes(c)) ?? [];
    let hidden;
    if (wanted.length > 0) {
        hidden = headers.filter((h) => !wanted.includes(h));
        headers = [...wanted];
    }
    else {
        const keep = readableColumnCount(headers.length);
        hidden = headers.slice(keep);
        headers = headers.slice(0, keep);
    }
    let rows = items.map((item) => headers.map((h) => formatCell(item[h])));
    if (multi)
        rows = rows.map((r) => r.map(firstLine));
    const natural = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => visibleWidth(r[i]))));
    const colWidths = fitColumns(natural);
    // Cut over-wide cells to their column rather than hard-wrapping them: wrapping
    // is right for one record (nothing is lost) but turns a 12-row list back into
    // the wall of text this whole path exists to avoid.
    if (multi && colWidths) {
        rows = rows.map((r) => r.map((c, i) => clampCell(c, colWidths[i] - 2)));
    }
    const table = new (tableCtor())({
        head: headers.map((h) => chalk().bold(h)),
        ...(colWidths ? { colWidths, wordWrap: true, wrapOnWordBoundary: false } : {}),
    });
    for (const row of rows)
        table.push(row);
    const out = [];
    if (folded.length > 0) {
        const label = `all ${items.length} rows`;
        const text = folded
            .map((h) => `${h}=${clampCell(firstLine(plain(formatCell(items[0][h]))), 40)}`)
            .join(" · ");
        out.push(...labeledLines(label, text, label.length + 2));
    }
    out.push(table.toString());
    if (hidden.length > 0) {
        const label = `${hidden.length} column${hidden.length === 1 ? "" : "s"} hidden`;
        const text = `${hidden.join(", ")} — pass --columns <csv>, or drop --pretty for the full JSON`;
        out.push(...labeledLines(label, text, label.length + 2));
    }
    if (envelope.nextCursor) {
        out.push(chalk().dim(`(more — pass --cursor ${envelope.nextCursor})`));
    }
    return out.join("\n");
}
export function renderRecord(record) {
    const entries = Object.entries(record).map(([k, v]) => [k, formatCell(v)]);
    if (entries.length === 0)
        return chalk().dim("(empty)");
    const natural = [
        Math.max(...entries.map(([k]) => k.length)),
        Math.max(...entries.map(([, v]) => visibleWidth(v))),
    ];
    const table = new (tableCtor())(fittedOptions(natural));
    for (const [k, v] of entries) {
        table.push({ [chalk().bold(k)]: v });
    }
    return table.toString();
}
/**
 * Envelope keys folded into the headline (or carrying nothing for a human):
 * `success` is always false on an error, `error`/`code` ARE the headline.
 */
const ERROR_HEADLINE_KEYS = new Set(["success", "error", "code"]);
/**
 * Human rendering of an error envelope for `--pretty` (stderr). Deliberately a
 * text block, not a `renderRecord` table: an error is one message plus a few
 * pointers, and the table's `success: false` / `statusCode: 0` rows are noise
 * that pushes the actual remedy off the bottom. The JSON default is untouched —
 * see `writeErrorEnvelope`.
 */
export function renderError(env, exitCode) {
    const c = chalk();
    const code = typeof env.code === "string" && env.code ? ` ${c.dim(`[${env.code}]`)}` : "";
    const lines = [c.red(`✗ ${String(env.error ?? "error")}`) + code];
    // Drop anything that carries no signal: the headline keys, nulls, an empty
    // list, and the placeholder statusCode 0 that every client-side error has.
    const rows = Object.entries(env).filter(([k, v]) => !ERROR_HEADLINE_KEYS.has(k) &&
        v !== null &&
        v !== undefined &&
        !(k === "statusCode" && v === 0) &&
        !(Array.isArray(v) && v.length === 0));
    const labelWidth = rows.length
        ? Math.max(...rows.map(([k]) => k.length)) + 2
        : 0;
    for (const [k, v] of rows) {
        lines.push(...labeledLines(k, errorValue(v), labelWidth));
    }
    if (exitCode !== undefined)
        lines.push("", c.dim(`(exit ${exitCode})`));
    return lines.join("\n");
}
/** Scalar lists read as prose (`list, current, switch`); everything else keeps
 *  the table renderer's formatting (so `problems[]` renders identically). */
function errorValue(value) {
    if (Array.isArray(value) && !value.some(isPlainObject)) {
        return value.map((v) => String(v)).join(", ");
    }
    return formatCell(value);
}
/** `  key:   value`, wrapped to the terminal with continuation lines hanging
 *  under the value column. */
function labeledLines(key, value, labelWidth) {
    const indent = " ".repeat(2 + labelWidth);
    const width = Math.max(terminalWidth() - indent.length, MIN_VALUE_WIDTH);
    const wrapped = [];
    for (const paragraph of value.split("\n")) {
        let line = "";
        for (const word of paragraph.split(" ")) {
            if (line && line.length + 1 + word.length > width) {
                wrapped.push(line);
                line = word;
            }
            else {
                line = line ? `${line} ${word}` : word;
            }
        }
        wrapped.push(line);
    }
    const label = "  " + chalk().dim(`${key}:`) + " ".repeat(labelWidth - key.length - 1);
    return wrapped.map((line, i) => (i === 0 ? label + line : indent + line));
}
/** Never wrap an error value narrower than this, however cramped the terminal. */
const MIN_VALUE_WIDTH = 20;
function isPlainObject(v) {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}
function formatCell(value) {
    if (value === null || value === undefined)
        return chalk().dim("—");
    if (Array.isArray(value) && value.length > 0 && value.every(isPlainObject)) {
        // feedback #34: JSON.stringify on an array of objects made the cell (and
        // the whole table) as wide as the JSON — render one "key: value" line per
        // element instead, dropping null fields.
        return value
            .map((row) => Object.entries(row)
            .filter(([, v]) => v !== null && v !== undefined)
            .map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
            .join("  "))
            .join("\n");
    }
    if (typeof value === "object")
        return JSON.stringify(value);
    return String(value);
}
//# sourceMappingURL=pretty.js.map