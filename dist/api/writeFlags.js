/**
 * Map a {@link WriteFlags} object to the matching HTTP header subset.
 *
 * Only flags that are truthy/non-empty produce a header — falsy values
 * are omitted entirely (no empty-string headers). Always safe to spread
 * into the `headers` option of `client.{post,put,delete}`.
 */
export function writeFlagsToHeaders(flags) {
    const headers = {};
    if (flags.dryRun)
        headers["X-Dry-Run"] = "1";
    if (flags.idempotencyKey)
        headers["Idempotency-Key"] = flags.idempotencyKey;
    if (flags.reason)
        headers["X-Action-Reason"] = flags.reason;
    return headers;
}
/**
 * Attach the three universal write flags to a commander subcommand so every
 * mutation in `ib` shares the same flag names + descriptions. Returns the
 * same command for chaining.
 */
export function addWriteFlagsToCommand(cmd) {
    return cmd
        .option("--dry-run", "Preview the write without persisting (X-Dry-Run)")
        .option("--idempotency-key <key>", "Dedupe retries of the same logical write (Idempotency-Key)")
        .option("--reason <text>", "Human-readable why-string stored in audit logs (X-Action-Reason)");
}
//# sourceMappingURL=writeFlags.js.map