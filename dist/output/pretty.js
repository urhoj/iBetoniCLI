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
export function renderList(envelope) {
    if (envelope.count === 0)
        return chalk.dim("(no results)");
    const headers = Object.keys(envelope.items[0]);
    const table = new (tableCtor())({ head: headers.map((h) => chalk.bold(h)) });
    for (const item of envelope.items) {
        table.push(headers.map((h) => formatCell(item[h])));
    }
    let out = table.toString();
    if (envelope.nextCursor) {
        out += `\n${chalk.dim(`(more — pass --cursor ${envelope.nextCursor})`)}`;
    }
    return out;
}
export function renderRecord(record) {
    const table = new (tableCtor())();
    for (const [k, v] of Object.entries(record)) {
        table.push({ [chalk.bold(k)]: formatCell(v) });
    }
    return table.toString();
}
function formatCell(value) {
    if (value === null || value === undefined)
        return chalk.dim("—");
    if (typeof value === "object")
        return JSON.stringify(value);
    return String(value);
}
//# sourceMappingURL=pretty.js.map