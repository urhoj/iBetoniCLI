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
import { canonicalPath } from "../reference/aliasPaths.js";
import { globalFlagsSummary } from "../globals.js";
import {
  type CallerTier,
  getCallerTier,
  isHiddenAtTier,
  hiddenCommandPaths,
  scrubSpecForTier,
} from "../tier.js";

interface CommandErrorBase {
  /** Process exit code per the documented contract (0/2/3/4/5/6/7). Always present. */
  exit: number;
  meaning: string;
  remedy: string;
  /**
   * Substring of the REAL error message this row documents — or several
   * alternatives, when one row covers a family of messages (match is ANY-of,
   * case-insensitive). Binds the row to its OWN failure instead of to any error
   * sharing its exit code / HTTP status. Optional on both origins, but the
   * fallback rule differs — see the two variants below.
   */
  match?: string | string[];
}

/**
 * One documented failure mode of a command. Every row MUST declare where the
 * error comes from — exactly one of `http` (the backend returned this status)
 * or `origin: "client"` (the CLI threw it locally, `CliError.statusCode === 0`).
 *
 * The obligation is load-bearing, not cosmetic: `hintForError` matches a row to
 * a real error by `http` for server-originated failures and by `exit` ONLY for
 * client-side ones. A server-originated row written without `http` is therefore
 * DEAD — it can never match, the command's own remedy is unreachable, and the
 * caller silently gets the generic per-status hint instead (feedback #280, then
 * #289, where an audit found four such rows and a manual sweep missed four
 * more). Making the union discriminated turns that omission into a compile
 * error. Do NOT "fix" a dead row by relaxing the matcher to fall back on exit
 * codes for HTTP errors: that would newly reach ~84 explicitly client-side rows
 * (e.g. `attachment download`'s "output file exists → pass --force" firing on
 * any server 409), trading one wrong hint for dozens.
 */
export type CommandError =
  | (CommandErrorBase & {
      /**
       * HTTP status when API-originated (401/403/404/409/429/400/500).
       *
       * Matched by status. Historically that was the WHOLE key, so a command
       * with two different causes behind one status served the first-listed
       * row's remedy for both — observed on `ib legal save`, where a truncation
       * 400 ("Arvo on liian pitkä sarakkeeseen 'title'.") answered with the
       * required-fields remedy even though every field was provided (fb#485).
       *
       * An optional `match` narrows a row to its own cause. Resolution order:
       * a row whose `match` hits the message wins; otherwise the first row with
       * NO `match` (the catch-all) wins, which is exactly the pre-fb#485
       * behaviour, so existing specs are unaffected. If every row at the status
       * declares `match` and none hit, the generic per-status hint is used.
       *
       * That last step is where http rows differ from client rows below: a
       * server message is usually self-explanatory and the generic per-status
       * hint is a decent floor, whereas a bare exit code says nothing. This
       * narrows matching WITHIN a status — it must never become an exit-code
       * fallback for HTTP errors (see the union doc above, fb#289).
       */
      http: number;
      origin?: never;
    })
  | (CommandErrorBase & {
      http?: never;
      /**
       * The CLI raised this locally (guard, parse, filesystem, read-only lock).
       *
       * Matched by exit code, and exit 4 covers nearly every local guard — so a
       * command with two client exit-4 rows served whichever was listed FIRST to
       * every hintless `failWith(msg, 4)` in the command. Real examples: `ib
       * commands nosuchdomain` answered with "--mutations and --reads are
       * mutually exclusive"; a bad `--asiakas` on `jerry check-address` answered
       * with "pass metres ≥ 0" (feedback #305/#306).
       *
       * A client row carrying `match` NEVER wins by exit code alone — it fires
       * only on a real substring hit. Exit-only matching survives only for a
       * command's single unambiguous client row; an ambiguous set yields NO
       * hint, because silence beats a confidently wrong remedy and there is no
       * useful generic exit-code hint to fall back to. `error-origins.test.ts`
       * enforces that client rows sharing an exit code each carry `match`, so a
       * second ambiguous row cannot be added silently.
       *
       * Note that rows documenting PARSE-level failures (excess args, unknown
       * option) are unreachable at runtime regardless: `handleParseRejection`
       * and `failValidation` build their own hint and never consult specs.
       * `match` keeps those documentation-only rows from being mis-served.
       */
      origin: "client";
    });

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
  /**
   * Machine-readable set of accepted values for an enum flag (e.g. `["fi","en"]`).
   * NOT rendered in `--help` (the prose description already states them) — it is
   * consumed by the prescriptive validation envelope (`buildValidationEnvelope`)
   * so a missing/invalid-flag error can list the allowed values inline, sparing
   * the caller a follow-up `--help` round-trip (feedback #204).
   */
  allowed?: string[];
  /**
   * Accepted input synonyms mapped to their canonical `allowed` value
   * (e.g. `{ fix: "bugfix", feat: "feature" }`). Surfaced in the validation
   * envelope alongside `allowed`; not rendered in `--help`.
   */
  synonyms?: Record<string, string>;
}

interface CommandSpecBase {
  /** Full command path, e.g. `ib keikka list`. */
  command: string;
  /**
   * Other FULL paths this same command answers to, via a Commander `.alias()`
   * on its leaf (e.g. `ib legal active` also runs as `ib legal list`).
   *
   * Load-bearing for identity, not decoration: Commander resolves an alias to
   * the canonical command and every downstream surface then reports the
   * CANONICAL name, so a caller who typed `ib legal list` was told "unknown
   * option on `ib legal active`" — a command they never named — and `--help`
   * headed itself `ib legal active` too. The momentary read is that the CLI
   * dispatched them somewhere else (feedback #342). {@link formatHelp} and
   * `buildUnknownOptionEnvelope` both name these so the two spellings are
   * visibly ONE command.
   *
   * Distinct from `reference/aliasPaths.ts`, which re-homes a whole PREFIX
   * (`ib feedback *` → `ib dev feedback *`); this is a per-leaf alias.
   * `help-wiring.test.ts` asserts these match the registered `.alias()` calls
   * exactly, so neither side can drift.
   */
  aliases?: string[];
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
   * Minimum tier required to SEE this command in discovery (not what can run it —
   * the server enforces real permissions). `"developer"` → global dev/sysadmin only;
   * `"admin"` → active-company admin/HR (or higher); absent → visible to everyone.
   * Machine-readable visibility gate; see `src/tier.ts` (`SpecTier`).
   */
  tier?: "admin" | "developer";
  /** Positional arguments rendered in USAGE and the ARGUMENTS section. */
  args?: CommandArg[];
  /** Command-specific flags rendered in the FLAGS section. */
  flags: CommandFlag[];
  /**
   * True when the command mutates data even if it doesn't use the standard
   * write-safety block (e.g. custom client-side dry-run). Falls back to
   * writeFlags for ib commands filtering.
   */
  mutates?: boolean;
  /**
   * Declares that this write REQUIRES `--reason` (the X-Action-Reason audit
   * string). Enforced CENTRALLY — buildProgram installs a preAction hook that
   * calls `requireReason` for any spec declaring a policy — so a new write
   * command states the requirement here instead of hand-calling the guard in
   * its action. `"always"` demands `--reason` unconditionally;
   * `"unless-dry-run"` lets `--dry-run` stand in (nothing is persisted, so
   * there is nothing to audit). Anti-drift: reason-policy.test.ts fails a spec
   * whose ERRORS prose names a missing `--reason` but declares no policy.
   */
  reasonPolicy?: "always" | "unless-dry-run";
  /** Optional parenthetical appended to the missing-`--reason` message (e.g. why the write is irreversible). */
  reasonDetail?: string;
  /** One-line description of the JSON response shape on stdout. */
  outputShape: string;
  /**
   * Columns `--pretty` should show for this command's list table, in order.
   * Only worth setting on a WIDE list (roughly >8 columns), where the automatic
   * leftmost-fits fallback in `renderList` would otherwise hide the columns a
   * caller actually triages by (feedback #341). Purely presentational — it does
   * not touch the JSON contract, and the global `--columns` overrides it (that
   * flag, unlike this default, also PROJECTS the payload itself — fb#451).
   */
  prettyColumns?: readonly string[];
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
 * The write-safety half of a {@link CommandSpec}, split out as a discriminated
 * union so that declaring the standard write flags FORCES a decision about how
 * `--dry-run` resolves — omitting `dryRunKind` on a `writeFlags: true` spec is a
 * COMPILE error, exactly as omitting `http`/`origin` is on a `CommandError`.
 *
 * This is load-bearing. `dryRunKind` used to be optional with ABSENT meaning
 * `"server"`, i.e. the unsafe reading was the default: authors got the
 * "backend skips persistence" help text for free without anyone checking that a
 * backend guard existed. Four commands shipped that way and silently PERSISTED
 * on `--dry-run` (weather toggle, keikka tila/set, sijainti delete/undelete).
 *
 * It describes what the CLI DOES, which is decidable from the run function:
 * - `"client"` — the CLI resolves the preview locally and NEVER issues the
 *   write. Safe by construction, and works under `--read-only`.
 * - `"server"` — the `X-Dry-Run` header is sent and the BACKEND is expected to
 *   skip persistence. Whether it actually does is a separate axis, enforced at
 *   runtime by the dry-run post-condition in `src/api/client.ts` (a 2xx with no
 *   `dryRun` marker is a hard exit 6 rather than a silent write).
 *
 * Drives the WRITE-SAFETY `--dry-run` help line and rides verbatim in
 * `ib reference dump` / `ib commands`.
 */
type WriteSafetySpec =
  | { writeFlags: true; dryRunKind: "server" | "client" }
  | { writeFlags?: false; dryRunKind?: "client" };

/**
 * A command's full specification: the descriptive half ({@link CommandSpecBase})
 * intersected with the write-safety half ({@link WriteSafetySpec}).
 */
export type CommandSpec = CommandSpecBase & WriteSafetySpec;

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
  // Surface REQUIRED flags inline in the usage line so the mandatory set is
  // learnable at a glance, not discovered one-at-a-time via runtime "required
  // option not specified" rejections (fb#189). Optional flags stay behind [flags].
  const requiredFlagSig = spec.flags
    .filter((f) => f.required)
    .map((f) => (f.type === "boolean" ? `--${f.name}` : `--${f.name} <${f.name}>`))
    .join(" ");
  const usageParts = [spec.command, argSig, requiredFlagSig, "[flags]"].filter(Boolean);
  lines.push(`  ${usageParts.join(" ")}`);
  // Name the leaf's other spellings HERE rather than only in a trailing NOTES
  // paragraph: a caller who typed the alias sees the canonical path as the very
  // first line of its own `--help` and has no way to tell it is the same
  // command until they read to the bottom (feedback #342).
  if (spec.aliases?.length) {
    lines.push(`  (also: ${spec.aliases.join(" · ")})`);
  }
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
      // Boolean flags are valueless switches — omit the "BOOLEAN" placeholder,
      // which reads as "pass a value" and leads callers to write `--flag false`
      // (a stray positional → a confusing "too many arguments" error). fb#176.
      const type = f.type === "boolean" ? "" : ` ${f.type.toUpperCase()}`;
      lines.push(
        `  --${f.name}${type}    ${f.description}${def}${req}`
      );
    }
  }

  if (spec.writeFlags) {
    lines.push("");
    lines.push("WRITE-SAFETY FLAGS");
    lines.push(
      spec.dryRunKind === "client"
        ? "  --dry-run            CLIENT-side preview: resolves locally, no write reaches the wire (works under --read-only)."
        : "  --dry-run            Validate without persisting (server-side X-Dry-Run). Returns the would-be response.\n                       If the backend does NOT honour it, the CLI exits 6 rather than reporting a write as a preview."
    );
    lines.push(
      "  --idempotency-key K  Replay protection. Cached for 24h."
    );
    lines.push(
      spec.reasonPolicy
        ? `  --reason TEXT        Free-text justification, stored in audit log. REQUIRED${
            spec.reasonPolicy === "unless-dry-run" ? " unless --dry-run" : ""
          }${spec.reasonDetail ? ` ${spec.reasonDetail}` : ""}.`
        : "  --reason TEXT        Free-text justification. Stored in audit log."
    );
  }

  lines.push("");
  lines.push("GLOBAL FLAGS");
  lines.push(`  ${globalFlagsSummary()}`);
  // One pointer, not ten expanded descriptions: `--company` is the only global
  // whose SEMANTICS a caller cannot guess from the name (it is an ephemeral
  // company switch, not a target-id filter — see the naming note in globals.ts),
  // and the cold-start probes inferred it from `whoami` output rather than any
  // doc (fb#380). `ib help multi-tenancy` already explains it in full, so point
  // there instead of growing every one of ~312 leaf helps by ten lines.
  lines.push(
    "  --company runs ONE command as another company (ephemeral, not persisted) · ib help multi-tenancy"
  );
  lines.push("");

  lines.push("OUTPUT (JSON, stdout)");
  lines.push(`  ${spec.outputShape}`);
  lines.push("");

  lines.push("ERRORS (stderr, exit non-zero)");
  for (const e of spec.errors) {
    // Name the origin explicitly: an AI reading this block otherwise cannot tell
    // whether a row fires on a backend status or on a local guard, which is the
    // same ambiguity that let dead rows accumulate in the specs (feedback #289).
    const origin = e.http ? ` (HTTP ${e.http})` : " (client-side)";
    lines.push(`  exit ${e.exit}${origin}  ${e.meaning.padEnd(22)} → ${e.remedy}`);
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
  tier: CallerTier = getCallerTier(),
  aliases: string[] = []
): string {
  const prefix = groupPath + " ";
  const depth = groupPath.split(" ").length; // child = token at this index
  const domain = groupPath.split(" ")[1];
  const groupName = groupPath.split(" ").at(-1)!.toLowerCase();

  // Re-homed back-compat alias: a group whose specs now live at a canonical
  // path elsewhere (`ib weather` → `ib opendata weather`, `ib cache` → `ib dev
  // cache`). The alias still executes, but no spec matches its old path, so
  // render the canonical group's help instead of the misleading "not available
  // at your access level" message. (Genuinely tier-hidden groups DO have specs
  // at their path — filtered out below — and still get hiddenAtTierMessage.)
  // The alias table is the single source; this used to hardcode "ib dev ".
  const canonical = canonicalPath(groupPath);
  if (canonical !== groupPath && !specs.some((s) => s.command.startsWith(prefix))) {
    if (specs.some((s) => s.command.startsWith(canonical + " "))) {
      return formatGroupHelp(canonical, fallbackDescription, specs, tier);
    }
  }

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
  // Same identity bridge a leaf gets from `spec.aliases` (feedback #342) — a
  // group reached as `ib message ilmoitustaulu` otherwise heads its own help
  // `ib message board` with nothing tying the two names together.
  if (aliases.length) lines.push(`  (also: ${aliases.join(" · ")})`);
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
    // Resolve back-compat aliases to their canonical spec, so an alias leaf
    // (`ib feedback create`) renders the SAME rich help as `ib dev feedback
    // create` instead of falling through to bare Commander output.
    const spec = byCommand.get(canonicalPath(full));
    if (spec) {
      // Single source: the Commander listing description IS the spec description.
      cmd.description(spec.description);
      cmd.configureHelp({
        formatHelp: () => {
          const tier = getCallerTier();
          if (isHiddenAtTier(spec, tier)) return hiddenAtTierMessage(full);
          // A VISIBLE command's own text must not name a command hidden at this
          // tier either — same cross-reference scrub the dump applies, so both
          // discovery surfaces share one invariant instead of one enforcing it
          // and the other leaking (feedback #288). No-op at developer tier.
          return formatHelp(
            scrubSpecForTier(spec, tier, hiddenCommandPaths(specs, tier))
          );
        },
      });
    } else if (path.length > 0 && cmd.commands.length > 0) {
      // Non-root group: computed group help (root keeps the domain primer).
      const fallback = cmd.description();
      // Groups have no spec to carry `aliases`, so read them off Commander
      // itself — same source `help-wiring.test.ts` checks the leaf specs against.
      const groupAliases = cmd.aliases().map((a) => [...path, a].join(" "));
      cmd.configureHelp({
        formatHelp: () =>
          formatGroupHelp(full, fallback, specs, getCallerTier(), groupAliases),
      });
    }
    for (const sub of cmd.commands) walk(sub, [...path, cmd.name()]);
  };
  walk(root, []);
}
