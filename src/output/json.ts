import { CliError } from "../api/errors.js";
import { isListEnvelope, type ListEnvelope } from "../api/envelopes.js";
import { renderList, renderRecord } from "./pretty.js";

let outputMode: "json" | "pretty" = "json";

export function setOutputMode(m: "json" | "pretty"): void {
  outputMode = m;
}

export function writeJson(value: unknown): void {
  if (outputMode === "pretty") {
    if (isListEnvelope(value)) {
      process.stdout.write(renderList(value as ListEnvelope<Record<string, unknown>>) + "\n");
      return;
    }
    if (value !== null && typeof value === "object") {
      process.stdout.write(renderRecord(value as Record<string, unknown>) + "\n");
      return;
    }
  }
  process.stdout.write(JSON.stringify(value) + "\n");
}

export function writeError(err: unknown): void {
  if (err instanceof CliError) {
    const body =
      err.body && typeof err.body === "object"
        ? (err.body as Record<string, unknown>)
        : {};
    process.stderr.write(
      JSON.stringify({
        success: false,
        error: err.message,
        code: body.code ?? null,
        statusCode: err.statusCode,
      }) + "\n"
    );
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(
    JSON.stringify({
      success: false,
      error: message,
      code: null,
      statusCode: 0,
    }) + "\n"
  );
}
