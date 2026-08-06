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
export function renderList(envelope) {
    // Guard on the actual array, not `count`: a backend page can report a
    // non-zero/absent `count` (total-count semantics, or an out-of-range cursor)
    // while `items` is empty — trusting `count` here would deref items[0] and
    // crash pretty mode with a raw TypeError.
    if (envelope.items.length === 0)
        return chalk().dim("(no results)");
    const headers = Object.keys(envelope.items[0]);
    const rows = envelope.items.map((item) => headers.map((h) => formatCell(item[h])));
    const natural = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => visibleWidth(r[i]))));
    let out;
    const naturalTotal = natural.reduce((a, w) => a + w + 2, 0);
    if (naturalTotal > availableWidth(headers.length) &&
        headers.length * READABLE_COL_WIDTH > availableWidth(headers.length)) {
        // Too many columns to cap into the terminal readably — render each item as
        // its own key:value block instead (feedback #34).
        out = envelope.items
            .map((item, i) => chalk().dim(`# ${i + 1}`) + "\n" + renderRecord(item))
            .join("\n");
    }
    else {
        const table = new (tableCtor())({
            head: headers.map((h) => chalk().bold(h)),
            ...fittedOptions(natural),
        });
        for (const row of rows)
            table.push(row);
        out = table.toString();
    }
    if (envelope.nextCursor) {
        out += `\n${chalk().dim(`(more — pass --cursor ${envelope.nextCursor})`)}`;
    }
    return out;
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