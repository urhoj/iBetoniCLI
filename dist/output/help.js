/**
 * AI-optimized `--help` formatter.
 *
 * Renders a {@link CommandSpec} as a stable, parse-friendly help string with
 * fixed sections (USAGE / DESCRIPTION / FLAGS / WRITE-SAFETY FLAGS / GLOBAL
 * FLAGS / OUTPUT / ERRORS / EXAMPLES). The output is deliberately
 * self-contained so that an AI consumer can ingest a single command's `--help`
 * and know everything needed to invoke it correctly: required permissions,
 * timezone semantics, exhaustive flag list, response shape, error remedies,
 * and copy-paste-ready examples.
 *
 * The same `CommandSpec` shape is also emitted as JSON by
 * `ib reference dump` (see `src/reference/dump.ts`), keeping the human help
 * and the machine reference in lockstep — one source of truth per command.
 *
 * `attachRichHelp` (bottom of this file) wires this renderer into each
 * subcommand's `--help`, so an AI inspecting a single command sees the full
 * spec without having to run `ib reference dump`.
 */
/**
 * Render a {@link CommandSpec} as the AI-optimized `--help` text. Output is a
 * trailing-newline-terminated string suitable for `process.stdout.write`.
 */
export function formatHelp(spec) {
    const lines = [];
    lines.push("USAGE");
    const argSig = (spec.args ?? [])
        .map((a) => (a.required === false ? `[<${a.name}>]` : `<${a.name}>`))
        .join(" ");
    lines.push(`  ${spec.command}${argSig ? " " + argSig : ""} [flags]`);
    lines.push("");
    lines.push("DESCRIPTION");
    lines.push(`  ${spec.description}`);
    if (spec.permissions?.length) {
        lines.push(`  Permissions: requires ${spec.permissions.join(", ")}.`);
    }
    else if (spec.auth === "any") {
        lines.push("  Auth: requires login (any authenticated user).");
    }
    else if (spec.auth === "none") {
        lines.push("  Auth: none (public).");
    }
    const hasDate = (spec.args ?? []).some((a) => a.type === "date") ||
        spec.flags.some((f) => f.type === "date");
    if (hasDate) {
        lines.push("  Timezone: dates interpreted in active company timezone (Europe/Helsinki).");
    }
    lines.push("");
    if (spec.args?.length) {
        lines.push("ARGUMENTS");
        for (const a of spec.args) {
            const req = a.required === false ? "(optional)" : "(required)";
            lines.push(`  <${a.name}> ${a.type.toUpperCase()}    ${a.description} ${req}`);
        }
        lines.push("");
    }
    lines.push("FLAGS");
    if (spec.flags.length === 0) {
        lines.push("  (none)");
    }
    else {
        for (const f of spec.flags) {
            const def = f.default ? ` (default: ${f.default})` : "";
            const req = f.required ? " (required)" : "";
            lines.push(`  --${f.name} ${f.type.toUpperCase()}    ${f.description}${def}${req}`);
        }
    }
    if (spec.writeFlags) {
        lines.push("");
        lines.push("WRITE-SAFETY FLAGS");
        lines.push("  --dry-run            Validate without persisting. Returns the would-be response.");
        lines.push("  --idempotency-key K  Replay protection. Cached for 24h.");
        lines.push("  --reason TEXT        Free-text justification. Stored in audit log.");
    }
    lines.push("");
    lines.push("GLOBAL FLAGS");
    lines.push("  --endpoint URL  --request-id ID  --quiet  --verbose  --pretty  --json  --read-only  --asiakas ID");
    lines.push("");
    lines.push("OUTPUT (JSON, stdout)");
    lines.push(`  ${spec.outputShape}`);
    lines.push("");
    lines.push("ERRORS (stderr, exit non-zero)");
    for (const e of spec.errors) {
        const http = e.http ? ` (HTTP ${e.http})` : "";
        lines.push(`  exit ${e.exit}${http}  ${e.meaning.padEnd(22)} → ${e.remedy}`);
    }
    lines.push("");
    lines.push("EXAMPLES");
    for (const ex of spec.examples) {
        lines.push(`  ${ex}`);
    }
    return lines.join("\n") + "\n";
}
/**
 * Walk the Commander tree rooted at `root` and replace the `--help` output of
 * every command whose full path (e.g. `ib keikka list`) matches a
 * {@link CommandSpec.command} with the rich {@link formatHelp} rendering.
 *
 * Group commands and any command without a matching spec keep Commander's
 * default auto-generated help. Matching is by exact path so the same
 * `COMMAND_SPECS` catalogue drives both per-command `--help` and
 * `ib reference dump` — there is no second source to drift.
 */
export function attachRichHelp(root, specs) {
    const byCommand = new Map(specs.map((s) => [s.command, s]));
    const walk = (cmd, path) => {
        const full = [...path, cmd.name()].join(" ");
        const spec = byCommand.get(full);
        if (spec) {
            cmd.configureHelp({ formatHelp: () => formatHelp(spec) });
        }
        for (const sub of cmd.commands)
            walk(sub, [...path, cmd.name()]);
    };
    walk(root, []);
}
//# sourceMappingURL=help.js.map