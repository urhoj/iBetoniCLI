import { failWith } from "../output/json.js";
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
 * Enforce the `--reason` audit string a lifecycle write requires, exiting 4
 * with one wording across the whole CLI (it was hand-written at ~36 call sites,
 * one of which had already grown its own private copy).
 *
 * Two variants, because the requirement genuinely differs per command:
 * `allowDryRun: true` matches the sites that let `--dry-run` stand in for a
 * reason (nothing is persisted, so there is nothing to audit); the default
 * demands `--reason` unconditionally. `detail` appends a command-specific
 * parenthetical (e.g. why the write is irreversible).
 */
export function requireReason(flags, opts = {}) {
    if (opts.allowDryRun && flags.dryRun)
        return;
    if (!flags.reason) {
        failWith(`Missing required flag: --reason${opts.detail ? ` ${opts.detail}` : ""}`, 4);
    }
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