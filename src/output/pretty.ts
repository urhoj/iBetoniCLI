import { createRequire } from "node:module";
import { ListEnvelope } from "../api/envelopes.js";

const require = createRequire(import.meta.url);

let _chalk: typeof import("chalk").default | null = null;
let _Table: typeof import("cli-table3") | null = null;

function chalk(): typeof import("chalk").default {
  return (_chalk ??= require("chalk").default ?? require("chalk"));
}

function tableCtor(): typeof import("cli-table3") {
  return (_Table ??= require("cli-table3"));
}

export function renderList(
  envelope: ListEnvelope<Record<string, unknown>>
): string {
  if (envelope.count === 0) return chalk().dim("(no results)");
  const headers = Object.keys(envelope.items[0]);
  const table = new (tableCtor())({ head: headers.map((h) => chalk().bold(h)) });
  for (const item of envelope.items) {
    table.push(headers.map((h) => formatCell(item[h])));
  }
  let out = table.toString();
  if (envelope.nextCursor) {
    out += `\n${chalk().dim(`(more — pass --cursor ${envelope.nextCursor})`)}`;
  }
  return out;
}

export function renderRecord(record: Record<string, unknown>): string {
  const table = new (tableCtor())();
  for (const [k, v] of Object.entries(record)) {
    table.push({ [chalk().bold(k)]: formatCell(v) });
  }
  return table.toString();
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return chalk().dim("—");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
