export class CliError extends Error {
  constructor(
    message: string,
    public statusCode: number,
    public body: unknown,
    public exitCode: number
  ) {
    super(message);
    this.name = "CliError";
  }
}

export function exitCodeFromStatus(status: number): number {
  if (status === 401) return 2;
  if (status === 403) return 3;
  if (status === 404) return 5;
  if (status >= 400 && status < 500) return 4;
  if (status >= 500) return 6;
  return 1;
}

/**
 * Resolve the process exit code for any thrown value, honouring the documented
 * exit-code contract: a {@link CliError} carries the status-mapped code
 * (2 auth · 3 permission · 4 validation · 5 not-found · 6 server · 7 network),
 * everything else falls back to the generic `1`.
 */
export function exitCodeForError(err: unknown): number {
  return err instanceof CliError ? err.exitCode : 1;
}

/**
 * Generic remedy hint for an error class, echoed into the stderr error
 * envelope as `hint`. The per-command spec NOTES/ERRORS carry the precise
 * remedy, but an agent that hasn't read them beforehand only sees the runtime
 * envelope — so the envelope itself must point at the next step (most
 * importantly the 404 deploy-gate ambiguity). `null` = no hint (the message is
 * already self-explanatory, e.g. read-only refusals).
 */
export function hintForError(err: CliError): string | null {
  if (err.exitCode === 7) {
    return "network failure (DNS/connection/TLS) — check connectivity and the --endpoint URL";
  }
  switch (err.statusCode) {
    case 401:
      return "token expired or invalid — run `ib auth refresh` (or `ib auth login`); IB_TOKEN sessions do not auto-refresh";
    case 403:
      return "permission denied — check the PERMISSIONS line in the command's --help and the active company via `ib auth whoami`";
    case 404:
      return "not found — the id may not exist in the ACTIVE company, OR this command's endpoint is not deployed on this backend yet (deploy-gated; see the command's --help NOTES and `ib version`)";
    default:
      if (err.statusCode >= 500) return "backend error — retry with --verbose; if it persists, file `ib feedback create --kind bug`";
      return null;
  }
}
