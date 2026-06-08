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

import type { Command } from "commander";

export interface CommandFlag {
  /** Flag name without leading dashes, e.g. `from`, `idempotency-key`. */
  name: string;
  /** Logical type label (e.g. `date`, `number`, `string`, `boolean`, `json`). */
  type: string;
  /** Optional default value displayed in parentheses after the description. */
  default?: string;
  /** One-line human description of the flag's purpose. */
  description: string;
}

export interface CommandSpec {
  /** Full command path, e.g. `ib keikka list`. */
  command: string;
  /** One-paragraph description of what the command does. */
  description: string;
  /** Backend permission strings (e.g. `auth.page.grid.tilaus.read`). */
  permissions?: string[];
  /** Command-specific flags rendered in the FLAGS section. */
  flags: CommandFlag[];
  /** When true, the WRITE-SAFETY FLAGS block is included. */
  writeFlags?: boolean;
  /** One-line description of the JSON response shape on stdout. */
  outputShape: string;
  /** Documented error codes with their meaning and remedy. */
  errors: { code: number; meaning: string; remedy: string }[];
  /** Copy-paste-ready invocation examples. */
  examples: string[];
}

/**
 * Render a {@link CommandSpec} as the AI-optimized `--help` text. Output is a
 * trailing-newline-terminated string suitable for `process.stdout.write`.
 */
export function formatHelp(spec: CommandSpec): string {
  const lines: string[] = [];

  lines.push("USAGE");
  lines.push(`  ${spec.command} [flags]`);
  lines.push("");

  lines.push("DESCRIPTION");
  lines.push(`  ${spec.description}`);
  if (spec.permissions?.length) {
    lines.push(`  Permissions: requires ${spec.permissions.join(", ")}.`);
  }
  lines.push(
    "  Timezone: dates interpreted in active company timezone (Europe/Helsinki)."
  );
  lines.push("");

  lines.push("FLAGS");
  if (spec.flags.length === 0) {
    lines.push("  (none)");
  } else {
    for (const f of spec.flags) {
      const def = f.default ? ` (default: ${f.default})` : "";
      lines.push(
        `  --${f.name} ${f.type.toUpperCase()}    ${f.description}${def}`
      );
    }
  }

  if (spec.writeFlags) {
    lines.push("");
    lines.push("WRITE-SAFETY FLAGS");
    lines.push(
      "  --dry-run            Validate without persisting. Returns the would-be response."
    );
    lines.push(
      "  --idempotency-key K  Replay protection. Cached for 24h."
    );
    lines.push(
      "  --reason TEXT        Free-text justification. Stored in audit log."
    );
  }

  lines.push("");
  lines.push("GLOBAL FLAGS");
  lines.push(
    "  --endpoint URL  --request-id ID  --quiet  --verbose  --pretty  --json  --read-only"
  );
  lines.push("");

  lines.push("OUTPUT (JSON, stdout)");
  lines.push(`  ${spec.outputShape}`);
  lines.push("");

  lines.push("ERRORS (stderr, exit non-zero)");
  for (const e of spec.errors) {
    lines.push(`  ${e.code}  ${e.meaning.padEnd(22)} → ${e.remedy}`);
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
export function attachRichHelp(root: Command, specs: CommandSpec[]): void {
  const byCommand = new Map(specs.map((s) => [s.command, s]));
  const walk = (cmd: Command, path: string[]): void => {
    const full = [...path, cmd.name()].join(" ");
    const spec = byCommand.get(full);
    if (spec) {
      cmd.configureHelp({ formatHelp: () => formatHelp(spec) });
    }
    for (const sub of cmd.commands) walk(sub, [...path, cmd.name()]);
  };
  walk(root, []);
}
