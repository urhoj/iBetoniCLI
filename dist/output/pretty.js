import { createRequire } from "node:module";
import chalk from "chalk";
// cli-table3 is CJS and the heavier of the two pretty-mode deps, so lazy-require
// it (safe on every supported Node). chalk 5 is ESM-only — a lazy require()
// would throw ERR_REQUIRE_ESM on Node <22.12 while the engines floor is 20.10,
// so keep chalk a static import (it is tiny and dependency-free).
const require = createRequire(import.meta.url);
let _Table = null;
function tableCtor() {
    return (_Table ??= require("cli-table3"));
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
    if (envelope.count === 0)
        return chalk.dim("(no results)");
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
            .map((item, i) => chalk.dim(`# ${i + 1}`) + "\n" + renderRecord(item))
            .join("\n");
    }
    else {
        const table = new (tableCtor())({
            head: headers.map((h) => chalk.bold(h)),
            ...fittedOptions(natural),
        });
        for (const row of rows)
            table.push(row);
        out = table.toString();
    }
    if (envelope.nextCursor) {
        out += `\n${chalk.dim(`(more — pass --cursor ${envelope.nextCursor})`)}`;
    }
    return out;
}
export function renderRecord(record) {
    const entries = Object.entries(record).map(([k, v]) => [k, formatCell(v)]);
    if (entries.length === 0)
        return chalk.dim("(empty)");
    const natural = [
        Math.max(...entries.map(([k]) => k.length)),
        Math.max(...entries.map(([, v]) => visibleWidth(v))),
    ];
    const table = new (tableCtor())(fittedOptions(natural));
    for (const [k, v] of entries) {
        table.push({ [chalk.bold(k)]: v });
    }
    return table.toString();
}
function isPlainObject(v) {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}
function formatCell(value) {
    if (value === null || value === undefined)
        return chalk.dim("—");
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