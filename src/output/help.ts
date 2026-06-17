/**
 * AI-optimized `--help` formatter.
 *
 * Renders a {@link CommandSpec} as a stable, parse-friendly help string. The
 * sections are emitted in this order, some conditionally: USAGE · DESCRIPTION
 * (with an optional Permissions/Auth line and a Timezone line when the command
 * has a date arg/flag) · ARGUMENTS (when `spec.args` is set) · FLAGS ·
 * WRITE-SAFETY FLAGS (when `spec.writeFlags`) · GLOBAL FLAGS · OUTPUT · ERRORS
 * (each as `exit N (HTTP M)`) · NOTES (when `spec.notes`) · SEE ALSO (when
 * `spec.seeAlso`) · EXAMPLES. The output is deliberately self-contained so that
 * an AI consumer can ingest a single command's `--help` and know everything
 * needed to invoke it correctly: positional arguments, auth/permissions,
 * timezone semantics, exhaustive flag list, response shape, error remedies
 * (with both exit code and HTTP status), related commands, and copy-paste-ready
 * examples.
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
import { domainBlurb } from "../reference/domain.js";
import { type CallerTier, getCallerTier, isHiddenAtTier } from "../tier.js";

export interface CommandError {
  /** HTTP status when API-originated (401/403/404/409/429/400/500). */
  http?: number;
  /** Process exit code per the documented contract (0/2/3/4/5/6/7). Always present. */
  exit: number;
  meaning: string;
  remedy: string;
}

export interface CommandArg {
  name: string;
  type: string;
  /** Defaults to true; set false for an optional positional. */
  required?: boolean;
  description: string;
}

export interface CommandFlag {
  /** Flag name without leading dashes, e.g. `from`, `idempotency-key`. */
  name: string;
  /** Logical type label (e.g. `date`, `number`, `string`, `boolean`, `json`). */
  type: string;
  /** Optional default value displayed in parentheses after the description. */
  default?: string;
  /** One-line human description of the flag's purpose. */
  description: string;
  /** When true, a (required) suffix is appended in the FLAGS section. */
  required?: boolean;
}

export interface CommandSpec {
  /** Full command path, e.g. `ib keikka list`. */
  command: string;
  /** One-paragraph description of what the command does. */
  description: string;
  /** Backend permission strings (e.g. `auth.page.grid.tilaus.read`). */
  permissions?: string[];
  /**
   * Auth requirement when no specific permissions are listed.
   * `"none"` = public, no token needed.
   * `"any"` = any authenticated user (valid login, no specific permission).
   * Ignored when `permissions` is set (permissions take precedence).
   */
  auth?: "none" | "any";
  /**
   * Minimum GLOBAL role tier required to even SEE this command in discovery
   * (`ib commands`, group/leaf `--help`, `ib reference dump`). Absent = visible
   * to everyone (default; the server still enforces real permissions).
   * `"developer"` = needs a global isDeveloper/isSystemAdmin token; eligible to
   * be hidden from non-developer / tokenless callers. Per-tenant company-admin
   * commands stay ABSENT (a non-developer admin legitimately runs them). The
   * `permissions[]` prose remains the human-readable detail; `tier` is purely
   * the machine-readable visibility gate. See `src/tier.ts`.
   */
  tier?: "developer";
  /** Positional arguments rendered in USAGE and the ARGUMENTS section. */
  args?: CommandArg[];
  /** Command-specific flags rendered in the FLAGS section. */
  flags: CommandFlag[];
  /** When true, the WRITE-SAFETY FLAGS block is included. */
  writeFlags?: boolean;
  /**
   * True when the command mutates data even if it doesn't use the standard
   * write-safety block (e.g. custom client-side dry-run). Falls back to
   * writeFlags for ib commands filtering.
   */
  mutates?: boolean;
  /** One-line description of the JSON response shape on stdout. */
  outputShape: string;
  /** Documented error codes with their meaning and remedy. */
  errors: CommandError[];
  /**
   * Preconditions, side-effects, gotchas, or flag-behaviour caveats that don't
   * fit in a single-sentence description. Rendered as a bulleted NOTES block
   * immediately before EXAMPLES. Each entry should be one distinct point.
   */
  notes?: string[];
  /**
   * Related command paths the caller should know about (e.g. the command to
   * run before/after this one). Rendered as a SEE ALSO line after NOTES.
   */
  seeAlso?: string[];
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
  const argSig = (spec.args ?? [])
    .map((a) => (a.required === false ? `[<${a.name}>]` : `<${a.name}>`))
    .join(" ");
  lines.push(`  ${spec.command}${argSig ? " " + argSig : ""} [flags]`);
  lines.push("");

  lines.push("DESCRIPTION");
  lines.push(`  ${spec.description}`);
  if (spec.permissions?.length) {
    lines.push(`  Permissions: requires ${spec.permissions.join(", ")}.`);
  } else if (spec.auth === "any") {
    lines.push("  Auth: requires login (any authenticated user).");
  } else if (spec.auth === "none") {
    lines.push("  Auth: none (public).");
  }
  const hasDate =
    (spec.args ?? []).some((a) => a.type === "date") ||
    spec.flags.some((f) => f.type === "date");
  if (hasDate) {
    lines.push(
      "  Timezone: dates interpreted in active company timezone (Europe/Helsinki)."
    );
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
  } else {
    for (const f of spec.flags) {
      const def = f.default ? ` (default: ${f.default})` : "";
      const req = f.required ? " (required)" : "";
      lines.push(
        `  --${f.name} ${f.type.toUpperCase()}    ${f.description}${def}${req}`
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
    "  --endpoint URL  --request-id ID  --quiet  --verbose  --pretty  --json  --read-only  --company ID"
  );
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

  if (spec.notes?.length) {
    lines.push("NOTES");
    for (const n of spec.notes) lines.push(`  - ${n}`);
    lines.push("");
  }
  if (spec.seeAlso?.length) {
    lines.push("SEE ALSO");
    lines.push(`  ${spec.seeAlso.join(", ")}`);
    lines.push("");
  }

  lines.push("EXAMPLES");
  for (const ex of spec.examples) {
    lines.push(`  ${ex}`);
  }

  return lines.join("\n") + "\n";
}

/** First sentence of a description — group/root listings stay one line per child. */
export function firstSentence(text: string): string {
  const i = text.indexOf(". ");
  return i === -1 ? text : text.slice(0, i + 1);
}

/**
 * Shared fallback text shown when a command or group is not visible at the
 * caller's tier. Used by {@link formatGroupHelp} (all children hidden) and by
 * {@link attachRichHelp} (a hidden leaf's own `--help`).
 */
export function hiddenAtTierMessage(path: string): string {
  return (
    `${path} is not available at your access level.\n` +
    "  Run `ib commands` to see the commands you can use.\n"
  );
}

/**
 * Render computed help for a GROUP command (e.g. `ib keikka`, `ib jerry offer`).
 *
 * Groups have no CommandSpec of their own; everything here is derived — the
 * subcommand table from the spec catalogue (children = unique next token after
 * the group path), the blurb from {@link domainBlurb} for the group's last
 * token (falling back to the Commander description), and the footer from the
 * group's domain. Mirrors `formatHelp`'s parse-friendly layout (uppercase
 * sections, two-space indent). No new source of truth → cannot drift from
 * `--help` / `ib reference dump` / `ib commands`.
 */
export function formatGroupHelp(
  groupPath: string,
  fallbackDescription: string,
  specs: CommandSpec[],
  tier: CallerTier = "developer"
): string {
  const prefix = groupPath + " ";
  const depth = groupPath.split(" ").length; // child = token at this index
  const domain = groupPath.split(" ")[1];
  const groupName = groupPath.split(" ").at(-1)!.toLowerCase();

  const inGroup = specs.filter(
    (s) => s.command.startsWith(prefix) && !isHiddenAtTier(s, tier)
  );
  const children = [...new Set(inGroup.map((s) => s.command.split(" ")[depth]))];
  if (children.length === 0) return hiddenAtTierMessage(groupPath);
  const byCommand = new Map(specs.map((s) => [s.command, s]));

  const blurb = domainBlurb(groupName) ?? fallbackDescription;

  const lines: string[] = [];
  lines.push("USAGE");
  lines.push(`  ${groupPath} <command> [flags]`);
  lines.push("");
  lines.push("DESCRIPTION");
  lines.push(`  ${blurb}`);
  lines.push("");
  lines.push("SUBCOMMANDS");
  const pad = Math.max(...children.map((c) => c.length));
  for (const child of children) {
    const leaf = byCommand.get(`${groupPath} ${child}`);
    const desc = leaf
      ? firstSentence(leaf.description)
      : `(group) → ${groupPath} ${child} --help`;
    lines.push(`  ${child.padEnd(pad)}  ${desc}`);
  }
  lines.push("");
  lines.push("DISCOVER");
  lines.push(`  ib reference dump ${domain}    Full specs for this group (JSON)`);
  lines.push(`  ${groupPath} <command> --help    Complete spec for one command`);
  lines.push("  ib help    Concept guides (offline)");
  return lines.join("\n") + "\n";
}

/**
 * Walk the Commander tree rooted at `root` and wire spec-driven help:
 *
 * - A command whose full path (e.g. `ib keikka list`) matches a
 *   {@link CommandSpec.command} gets the rich {@link formatHelp} rendering,
 *   AND its Commander description is overwritten with `spec.description` —
 *   the spec is the single source for leaf descriptions (group listings,
 *   `ib commands`, and `--help` all show the same string).
 * - A non-root command with subcommands (a group — no spec of its own) gets
 *   the computed {@link formatGroupHelp} rendering.
 * - The root keeps Commander's default help + the domain primer appended via
 *   `addHelpText` in `program.ts` — but its command list truncates each
 *   subcommand description to its first sentence (`subcommandDescription`
 *   override in `buildProgram`), same as group listings; full descriptions
 *   stay one `--help` away.
 *
 * Matching is by exact path so the same `COMMAND_SPECS` catalogue drives
 * per-command `--help`, group help, and `ib reference dump` — there is no
 * second source to drift.
 */
export function attachRichHelp(root: Command, specs: CommandSpec[]): void {
  const byCommand = new Map(specs.map((s) => [s.command, s]));
  const walk = (cmd: Command, path: string[]): void => {
    const full = [...path, cmd.name()].join(" ");
    const spec = byCommand.get(full);
    if (spec) {
      // Single source: the Commander listing description IS the spec description.
      cmd.description(spec.description);
      cmd.configureHelp({
        formatHelp: () =>
          isHiddenAtTier(spec, getCallerTier())
            ? hiddenAtTierMessage(full)
            : formatHelp(spec),
      });
    } else if (path.length > 0 && cmd.commands.length > 0) {
      // Non-root group: computed group help (root keeps the domain primer).
      const fallback = cmd.description();
      cmd.configureHelp({
        formatHelp: () =>
          formatGroupHelp(full, fallback, specs, getCallerTier()),
      });
    }
    for (const sub of cmd.commands) walk(sub, [...path, cmd.name()]);
  };
  walk(root, []);
}
