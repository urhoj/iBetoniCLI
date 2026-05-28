import { CliError } from "../api/errors.js";

export function writeJson(value: unknown): void {
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
