/**
 * `--body <json>` + `--from-json <file|->` registered as ONE unit (fb#808).
 *
 * WHY THIS EXISTS. `--from-json` is not part of {@link addWriteFlagsToCommand}
 * — that supplies only the write-safety trio — so every command offering it had
 * to declare it by hand. CLAUDE.md and the CLI's own error text both describe
 * `--from-json` as THE shell-safe route for a payload on Windows, which reads as
 * a universal write flag; it was not. The gap was invisible until an unattended
 * run hit it: 14 commands owned a `--body` payload with no file escape hatch at
 * all, `parseBody.ts`'s own shell-mangled-`--body` hint told those callers to
 * "pass the JSON via --from-json <file|->", and `ib sijainti create`'s spec said
 * the same in prose — all naming a flag the command did not register.
 *
 * Registering the pair together is what makes that undriftable: a command that
 * takes an inline JSON body now cannot acquire one without its file twin, and
 * `test/reference/from-json-parity.test.ts` fails the build if one appears.
 *
 * NOT for the prose commands. A `--body <text>` (a chat message, an email body)
 * is a FIELD, not the request payload, so its `--from-json` means "keys are this
 * command's flags" and goes through {@link applyFromJson} instead. Both spellings
 * are "the payload as a JSON object in a file", which is the contract a caller
 * actually holds; only the mapping differs.
 */
import type { Command } from "commander";
import { resolveJsonObjectBody } from "../../api/parseBody.js";
import { failValidation } from "../../output/json.js";
import { commandPath, specForPath } from "../../output/unknownCommand.js";

/** The option pair, in the order help renders them. Chainable. */
export function addJsonBodyOptions(cmd: Command): Command {
  return cmd.option("--body <json>").option("--from-json <file>");
}

/** The two option attributes {@link addJsonBodyOptions} registers. */
export interface JsonBodyFlags {
  body?: string;
  fromJson?: string;
}

/**
 * Resolve the JSON-object payload from whichever of the two flags was passed.
 *
 * `required: true` replaces what `.requiredOption("--body")` used to do. It has
 * to be a RUNTIME check now, because Commander's own required-option gate fires
 * during parse — before it has looked at anything else — so a command that kept
 * `--body` mandatory would answer `ib X --from-json f.json` with "missing
 * required flag: --body", masking the fact that the caller's payload was already
 * supplied (and, before this change, that `--from-json` was not even accepted;
 * that masking shape is fb#1179). The envelope emitted here is the same
 * `failValidation` shape the parser layer emits — same `problems[]`, same
 * spec-derived `sample` — so the only visible difference is the added remedy
 * naming the file route.
 */
export function resolveJsonBody(
  cmd: Command,
  o: JsonBodyFlags,
  { required = false }: { required?: boolean } = {}
): Record<string, unknown> | null {
  const parsed = resolveJsonObjectBody({ body: o.body, fromJson: o.fromJson });
  if (parsed || !required) return parsed;
  const path = commandPath(cmd);
  failValidation(
    path,
    [
      {
        flag: "--body",
        issue: "missing",
        remedy:
          "pass the JSON object inline with --body, or from a file with --from-json <file|-> (the shell-safe route on Windows PowerShell, which splits an inline value on its inner double-quotes)",
      },
    ],
    { spec: specForPath(path) }
  );
}

/** `bumpLevel` → `--bump-level`, the spelling every envelope and spec uses. */
const longFlagOf = (attr: string): string => `--${attr.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;

/**
 * Runtime stand-in for `.requiredOption(...)` on a command that ALSO accepts
 * `--from-json`.
 *
 * Commander's own required-option gate fires during parse, before any value
 * from a `--from-json` document has been merged in, so a still-mandatory flag
 * rejects the very invocation the file route exists to enable: `ib message chat
 * send --from-json msg.json` would answer "missing required flag: --body" while
 * holding the body in its hand. Checking after {@link applyFromJson} instead
 * keeps the requirement and lets either spelling satisfy it.
 *
 * The envelope is `failValidation`'s, which is the same builder the parser
 * branch uses — identical `problems[]`, spec-derived `sample`, exit 4 — so
 * nothing regresses for the caller who simply forgot the flag.
 */
export function requireFlags(
  cmd: Command,
  o: Record<string, unknown>,
  attrs: string[]
): void {
  const missing = attrs.filter((a) => o[a] === undefined || o[a] === "");
  if (!missing.length) return;
  const path = commandPath(cmd);
  failValidation(
    path,
    missing.map((a) => ({
      flag: longFlagOf(a),
      issue: "missing" as const,
      remedy: `pass ${longFlagOf(a)}, or supply it as a key in --from-json <file|->`,
    })),
    { spec: specForPath(path) }
  );
}
