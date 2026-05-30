import Table from "cli-table3";
import chalk from "chalk";
export function renderList(envelope) {
    if (envelope.count === 0)
        return chalk.dim("(no results)");
    const headers = Object.keys(envelope.items[0]);
    const table = new Table({ head: headers.map((h) => chalk.bold(h)) });
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
    const table = new Table();
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