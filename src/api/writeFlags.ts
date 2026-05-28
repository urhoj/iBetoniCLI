import type { Command } from "commander";

/**
 * Universal write-flag set shared by every `ib` mutation command.
 *
 *   --dry-run             → sends `X-Dry-Run: 1`; backend skips persistence
 *                           and returns the would-be result for previewing.
 *   --idempotency-key K   → sends `Idempotency-Key: K`; backend dedupes
 *                           retries of the same logical write.
 *   --reason TEXT         → sends `X-Action-Reason: TEXT`; backend stores
 *                           the human-readable why-string in audit logs.
 *
 * Flags are independent — any subset may be set, and the empty case
 * (no flags supplied) yields zero added headers so callers can pass
 * the result straight into `client.post(..., { headers })`.
 */
export interface WriteFlags {
  dryRun?: boolean;
  idempotencyKey?: string;
  reason?: string;
}

/**
 * Map a {@link WriteFlags} object to the matching HTTP header subset.
 *
 * Only flags that are truthy/non-empty produce a header — falsy values
 * are omitted entirely (no empty-string headers). Always safe to spread
 * into the `headers` option of `client.{post,put,delete}`.
 */
export function writeFlagsToHeaders(
  flags: WriteFlags
): Record<string, string> {
  const headers: Record<string, string> = {};
  if (flags.dryRun) headers["X-Dry-Run"] = "1";
  if (flags.idempotencyKey) headers["Idempotency-Key"] = flags.idempotencyKey;
  if (flags.reason) headers["X-Action-Reason"] = flags.reason;
  return headers;
}

/**
 * Attach the three universal write flags to a commander subcommand so every
 * mutation in `ib` shares the same flag names + descriptions. Returns the
 * same command for chaining.
 */
export function addWriteFlagsToCommand(cmd: Command): Command {
  return cmd
    .option("--dry-run", "Preview the write without persisting (X-Dry-Run)")
    .option(
      "--idempotency-key <key>",
      "Dedupe retries of the same logical write (Idempotency-Key)"
    )
    .option(
      "--reason <text>",
      "Human-readable why-string stored in audit logs (X-Action-Reason)"
    );
}
