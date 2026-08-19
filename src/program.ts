/**
 * Builds the wired `ib` Commander program.
 *
 * Extracted from `bin/ib.ts` so the command tree — including the rich `--help`
 * wiring — is importable by tests without triggering argv parsing. `bin/ib.ts`
 * is now just a thin shell: build, then `parseAsync`.
 *
 * WHICH commands get registered depends on the argv hint — see `domains.ts`.
 * Only `reference` and `commands` are wired here, because they close over this
 * function's helpers rather than living in a `commands/<domain>` module.
 */
import { Command, Help, type Option } from "commander";
import packageJson from "../package.json" with { type: "json" };
import { addGlobalOptions, getGlobalOptions, type GlobalOptions } from "./globals.js";
import { defaultCredentialsPath } from "./auth/store.js";
import { createCliContext } from "./cliContext.js";
import { recordFriction } from "./friction.js";
import type { ApiClient } from "./api/client.js";
import { DOMAIN_REGISTRARS, resolveArgvDomain, argvRestAfterDomain, type DomainDeps } from "./domains.js";
import { runReferenceDump, fetchPrimerGlossary } from "./reference/dump.js";
import { runReferenceDetail, runReferenceDetailSet, runReferenceDetailList, runReferenceDetailEdit, runReferenceDetailDelete, runReferenceDetailLint, type ReferenceDetailListOptions } from "./reference/detail.js";
import { addEditFlags, parseEditOp } from "./textEdit.js";
import { intFlag } from "./targets.js";
import { addWriteFlagsToCommand, type WriteFlags, requireReason } from "./api/writeFlags.js";
import { assertAiConfidence, addAssessWriteFlags, addNeedsReviewFlags } from "./assess.js";
import { buildCommandsList, buildDomainIndex, fullyHiddenDomains, assertKnownDomain } from "./reference/commandsList.js";
import { renderDomainHelp } from "./reference/domain.js";
import { attachRichHelp, firstSentence, type CommandSpec } from "./output/help.js";
import { COMMAND_SPECS } from "./reference/specs.js";
import { canonicalPath } from "./reference/aliasPaths.js";
import { writeJson, exitWithError, failWith, failUsage, emitStdout, emitStderr, writeErrorEnvelope, setActiveCommandErrors, setListColumns, setExitCode as setExit, errorMessage } from "./output/json.js";
import { guarded, jsonAction } from "./commands/_shared/action.js";
import { applyFromJson, type FromJsonConfig } from "./commands/_shared/fromJson.js";
import { buildValidationEnvelope, type FlagProblem } from "./output/validationEnvelope.js";
import { buildUnknownCommandEnvelope, buildUnknownOptionEnvelope, buildExcessArgumentsEnvelope, dateFlagSuggestion, excessPositionals, commandPath, type UnknownCommandEnvelope } from "./output/unknownCommand.js";
import { getEmbeddedCtx } from "./embedded.js";
import { CliError } from "./api/errors.js";
import { getCallerTier } from "./tier.js";

/**
 * What a single invocation acts as: the resolved root globals, plus the caller's
 * JWT when the invocation is EMBEDDED (in-process `/api/cli/exec`). Built once
 * per factory call by `buildProgram`'s `invocation()`, which is the only reader
 * of the embedded context.
 */
interface Invocation {
  global: GlobalOptions;
  /** The embedded caller's JWT; absent in normal CLI mode. */
  embeddedToken?: string;
}

/**
 * Construct the `ib` program with rich (`CommandSpec`-driven) `--help` attached.
 * Does not parse argv.
 *
 * `argv` is a HINT (the caller's arguments, without node/script): when its first
 * bare token names a known domain, only that domain's modules are imported and
 * registered — the rest of the ~40 command modules are never loaded. Omit it, or
 * pass an argv that starts with a flag or names something unknown, and the whole
 * tree is registered as before; every surface that needs all the commands (root
 * help, unknown-command siblings) is reached only through that path. Tests and
 * library callers that want the full tree simply omit the argument.
 */
export async function buildProgram(argv?: readonly string[]): Promise<Command> {
  const program = new Command();
  program
    .name("ib")
    .description("iBetoni CLI — AI-driven command-line interface for betoni.online and betoniJerry")
    .version(packageJson.version);
  // Domain primer (what betoni.online is + glossary) on the root `--help`, so an
  // AI inspecting top-level help gets the same context `ib reference dump`
  // embeds. Sourced from reference/domain.ts — one source of truth, no drift.
  program.addHelpText("after", () => renderDomainHelp());
  // Root command list is a table of contents: first sentence only (same
  // truncation formatGroupHelp applies to group listings); the full
  // description stays in each command's `--help`.
  // The root command has no CommandSpec, so `attachRichHelp` does not override
  // its help — Commander's DEFAULT listing renders ALL registered subcommands,
  // including developer-only groups (ai/schema/changelog) that are hidden at
  // standard tier. Override `visibleCommands` so fully-hidden SPEC domains drop
  // from the "Commands:" section at render time. Meta commands (commands,
  // reference, help, doctor, version, auth) and partial domains are never in
  // `fullyHiddenDomains`, so they stay; at developer tier the set is empty →
  // identical to today (no snapshot drift).
  program.configureHelp({
    subcommandDescription: (cmd) => firstSentence(cmd.description()),
    visibleCommands(cmd) {
      const hidden = fullyHiddenDomains(getCallerTier());
      return Help.prototype.visibleCommands
        .call(this, cmd)
        .filter((sub) => !hidden.has(sub.name()));
    },
  });
  addGlobalOptions(program);

  // Two pre-flight guards, for every consumer of the built tree (bin, runArgv,
  // tests). The eaten-empty-string check runs FIRST: when PowerShell drops an
  // empty `--reason ""` the NEXT flag becomes its value, so --reason looks
  // satisfied and enforceSpecReasonPolicy would wave through a write whose audit
  // reason is the literal string "--dry-run".
  program.hook("preAction", (_thisCommand, actionCommand) => {
    assertNoEatenEmptyString(program, actionCommand);
    enforceSpecReasonPolicy(actionCommand);
  });

  // The acting context of this invocation: the parsed root globals, plus the
  // EMBEDDED caller's identity when this process is serving an in-process
  // `/api/cli/exec` call. This is the ONE place `getEmbeddedCtx()` is consulted,
  // and every factory below resolves through it — so `getClient`,
  // `getClientForAsiakas`, `getEndpoint` and `isReadOnly` all act with the
  // caller's endpoint / token / write-lock. (Only `getClient` used to special-
  // case the embedded context, which left an in-process call probing the
  // SERVER's endpoint, minting per-company clients from the SERVER's credentials
  // file, and slipping past the `isReadOnly()` gate.)
  //
  // Embedded values WIN over argv: the endpoint is the server's own base URL, so
  // an argv `--endpoint` from a remote caller cannot redirect their JWT to a host
  // of their choosing, and the write-lock can only be tightened. Diagnostics
  // (acting-as, retry notes) go through the ctx-aware `warnNote`/`emitStderr`,
  // so they reach the embedded CALLER's stderr — no forced `quiet` needed.
  function invocation(): Invocation {
    const global = getGlobalOptions(program);
    const emb = getEmbeddedCtx();
    if (!emb) return { global };
    return {
      global: {
        ...global,
        endpoint: emb.endpoint,
        readOnly: global.readOnly || emb.readOnly,
      },
      embeddedToken: emb.token,
    };
  }

  // One CLI context per distinct company lens, memoized for the invocation.
  // Building it reads+parses the credentials file and decodes the JWT, and under
  // `--company <id>` it mints an ephemeral switch JWT via a NETWORK POST — so a
  // command needing both a client and the endpoint (e.g. `ib doctor`) otherwise
  // paid for all of that twice, including a redundant round-trip. Keyed by
  // `asiakas` because `getClientForAsiakas` deliberately wants a different
  // context per target company.
  const ctxCache = new Map<number | null, ReturnType<typeof createCliContext>>();
  function contextFor(inv: Invocation): ReturnType<typeof createCliContext> {
    const key = inv.global.asiakas ?? null;
    let pending = ctxCache.get(key);
    if (!pending) {
      pending = createCliContext({
        credentialsPath: defaultCredentialsPath(),
        version: packageJson.version,
        global: inv.global,
        embeddedToken: inv.embeddedToken,
      });
      ctxCache.set(key, pending);
    }
    return pending;
  }

  // Build an authenticated client from a resolved invocation. Exits 2 with
  // "Not logged in" when no auth resolves — so command actions never deal with
  // the unauthenticated case. The two factories below differ only in the
  // invocation they pass in.
  async function clientFrom(inv: Invocation): Promise<ApiClient> {
    const ctx = await contextFor(inv);
    if (!ctx.client) {
      // throw (not process.exit) — safe post-fetch on Windows; lands in the
      // action's exitWithError catch (or the bin catch) as envelope + exit 2.
      failWith("Not logged in. Run `ib auth login` first.", 2);
    }
    return ctx.client;
  }

  const getClient = (): Promise<ApiClient> => clientFrom(invocation());

  // A client bound to a SPECIFIC company via an ephemeral switch (never
  // persisted). Reuses the same tested switch path and inherits
  // read-only/endpoint/version — and, in embedded mode, derives from the
  // caller's JWT. Powers `person search --my-companies` fan-out.
  const getClientForAsiakas = (asiakasId: number): Promise<ApiClient> => {
    const inv = invocation();
    return clientFrom({ ...inv, global: { ...inv.global, asiakas: asiakasId } });
  };

  // Resolve the active endpoint WITHOUT requiring auth — `createCliContext`
  // returns a usable `endpoint` (--endpoint → active profile → default) even
  // when no credentials resolve. Powers `ib version`, which queries the public
  // `/api/version` and so must work logged out.
  async function getEndpoint(): Promise<string> {
    return (await contextFor(invocation())).endpoint;
  }

  // Disable Commander's built-in `help` command so `ib help [topic]` can
  // register our own offline concept-guide action without conflict.
  // `ib --help` (the --help OPTION) is unaffected and still renders the domain
  // primer via `program.addHelpText("after", renderDomainHelp())` above.
  program.helpCommand(false);

  // Session write-lock resolver, evaluated at action time (after argv parse).
  // Passed to commands that mutate OUTSIDE the API client (persisted company
  // switch) so read-only mode covers them too, and to `doctor` for reporting.
  const isReadOnly = (): boolean => invocation().global.readOnly;

  // Load + register the domains this invocation needs — one of them when argv
  // names a known command, otherwise all of them. `DOMAIN_REGISTRARS` iterates
  // in registration order, which is what `ib --help` lists.
  const deps: DomainDeps = {
    getClient,
    getClientForAsiakas,
    isReadOnly,
    getEndpoint,
    version: packageJson.version,
    argvRest: argvRestAfterDomain(argv),
  };
  const selected = resolveArgvDomain(argv);
  for (const [domain, register] of DOMAIN_REGISTRARS) {
    if (selected === null || selected === domain) await register(program, deps);
  }

  const reference = program
    .command("reference")
    .description("Reference / meta commands (machine-readable CLI catalogue)");
  reference
    .command("dump")
    .argument(
      "[domain...]",
      "Restrict the commands map to one or more domains — the token after `ib` (e.g. keikka). Multiple domains share a single primer."
    )
    .option(
      "--glossary"
    )
    .option(
      "--commands-only"
    )
    .option(
      "--lean"
    )
    .action(
      guarded(async (
        domains: string[],
        opts: { glossary?: boolean; commandsOnly?: boolean; lean?: boolean }
      ) => {
        let glossary: Array<{ term: string; synonyms: string[] }> = [];
        // The glossary is now OPT-IN: only fetch it when --glossary is asked
        // for (and never under --commands-only, which has no primer). The
        // fetch is this command's only network call, so the default dump is
        // also offline + token-free.
        if (opts.glossary && !opts.commandsOnly) {
          try { glossary = await fetchPrimerGlossary(await getClient()); } catch { glossary = []; }
        }
        runReferenceDump(
          domains,
          getCallerTier(),
          glossary,
          opts.commandsOnly ?? false,
          opts.lean ?? false
        );
      })
    );
  // `detail` is a PURE GROUP (no action of its own) with three explicit leaves.
  // A variadic action on the group AND `list`/`set` subcommands would make
  // commander mis-route `ib reference detail keikka list` to the `list` leaf —
  // so the read is an explicit `get <command...>` leaf instead.
  const detail = reference
    .command("detail")
    .description(
      "On-demand command catalog: get/set business-context detail + summary, or list entries (DB-backed)"
    );

  detail
    .command("get")
    .argument("<command...>", "Command path after `ib` (e.g. keikka latest)")
    .action(jsonAction(getClient, (client, commandParts: string[]) => runReferenceDetail(client, commandParts)));

  addNeedsReviewFlags(
    detail
      .command("list")
      // intFlag, not a bare Number: a NaN cap is dropped by `stalest || undefined`
      // and the server then returns the WHOLE catalog — the fb#249 failure shape,
      // where a typo silently widens the result instead of failing.
      .option("--stalest <n>", "", intFlag("--stalest", 1))
      .option("--domain <d>")
      .option("--with-detail")
      .option("--search <substr>")
      .option("--orphans")
      .option("--limit <n>", "", intFlag("--limit", 1))
  ).action(guarded(async (opts: ReferenceDetailListOptions) => {
    // Validate the domain offline (exit 4 on unknown) before any network call,
    // mirroring `ib commands <domain>`.
    if (opts.domain) assertKnownDomain(COMMAND_SPECS, opts.domain);
    const client = await getClient();
    writeJson(await runReferenceDetailList(client, opts));
  }));

  // `ib reference detail set` writes long Finnish-bearing prose into
  // dbo.ibcli_commandCatalog, and Windows PowerShell reinterprets UTF-8 native
  // arguments as latin1 — so `Ylijäämäbetonin` stored as `YlijÃ¤Ã¤mÃ¤betonin`
  // while the call exited 0 and echoed success (fb#613). That is uniquely bad
  // here: the catalog is served to AI agents as authoritative, lives outside
  // git, and nothing diffs or lints it, so a corrupted write is invisible until
  // somebody reads the row back and happens to look at the Finnish. `--from-json`
  // sidesteps argv entirely — the same reason `ib glossary set/import` took it.
  //
  // needsHumanReview / all are EXCLUDED for the fb#541 reason: the accepted-key
  // list is derived from the command's flags, so advertising a VALUELESS boolean
  // creates a key that cannot work — `true` exits 4 ("must be a string") and
  // `"true"` is accepted and SILENTLY DROPPED, parking (or failing to park) a row
  // against the caller's belief. Nothing is lost by omitting them: neither takes
  // a value, so neither has a shell-quoting problem, and both can be passed on
  // argv alongside --from-json. Excluded here they are loudly rejected as unknown.
  const DETAIL_SET_FROM_JSON: FromJsonConfig = {
    nonPayload: new Set([
      "fromJson",
      "dryRun",
      "idempotencyKey",
      "reason",
      "help",
      "needsHumanReview",
      "all",
    ]),
    numericFields: new Set(["aiConfidence"]),
  };

  const detailSet = detail
    .command("set")
    .argument("<command...>", "Command path after `ib` (e.g. keikka latest)")
    .option("--summary <text>")
    .option("--detail <text>")
    .option("--field <name>")
    .option("--from-json <file>");
  addEditFlags(detailSet);
  addWriteFlagsToCommand(addAssessWriteFlags(detailSet)).action(
    guarded(async (
      commandParts: string[],
      opts: WriteFlags & {
        summary?: string;
        detail?: string;
        aiConfidence?: number;
        needsHumanReview?: boolean;
        field?: string;
        replace?: string;
        with?: string;
        append?: string;
        prepend?: string;
        all?: boolean;
        fromJson?: string;
      },
      cmd: Command
    ) => {
      // MUST precede parseEditOp: --from-json fills the option values the mode
      // guards below then read (fb#613).
      applyFromJson(cmd, opts as Record<string, unknown>, DETAIL_SET_FROM_JSON);
      const editOp = parseEditOp(opts);
      if (opts.field !== undefined && !editOp) {
        failUsage("--field only applies in edit mode (--replace / --append / --prepend)");
      }
      if (editOp) {
        if (opts.summary !== undefined || opts.detail !== undefined) {
          failUsage("edit mode (--replace/--append/--prepend) cannot be combined with --summary/--detail");
        }
        const field = (opts.field ?? "detail") as "summary" | "detail";
        if (field !== "summary" && field !== "detail") {
          failUsage("--field must be one of: summary, detail");
        }
        // Deliberate exception to the spec-declared reasonPolicy migration:
        // --reason is required only in EDIT mode (a conditional the spec cannot
        // express), so this one guard stays hand-called.
        requireReason(opts, { allowDryRun: true });
        try {
          const client = await getClient();
          writeJson(
            await runReferenceDetailEdit(client, commandParts, field, editOp, opts)
          );
        } catch (e) {
          exitWithError(e);
        }
        return;
      }
      assertAiConfidence(opts.aiConfidence);
      const client = await getClient();
      const result = await runReferenceDetailSet(
        client,
        commandParts,
        { summary: opts.summary, detail: opts.detail, aiConfidence: opts.aiConfidence, needsHumanReview: opts.needsHumanReview },
        opts
      );
      writeJson(result);
    })
  );

  // `delete` — prune one catalog row by its EXACT key. Deliberately NOT gated by
  // the command registry (unlike get/set): its purpose is removing orphans whose
  // command path no longer resolves. --reason required for a real delete.
  const detailDelete = detail
    .command("delete")
    .argument("<command...>", "The exact stored command key after `ib` (e.g. ai conversation)");
  addWriteFlagsToCommand(detailDelete).action(
    guarded(async (commandParts: string[], opts: WriteFlags) => {
      const client = await getClient();
      writeJson(await runReferenceDetailDelete(client, commandParts, opts));
    })
  );

  // `lint` — audit the catalog for orphan rows (keys with no live command left
  // by a rename/re-home). Read-only (one GET + local diff); --strict is a CI gate.
  detail
    .command("lint")
    .option("--strict")
    .action(guarded(async (opts: { strict?: boolean }) => {
      const res = await runReferenceDetailLint(await getClient());
      writeJson(res);
      if (opts.strict && res.items.length > 0) setExit(1);
    }));

  // `ib commands` — filtered, offline discovery over the same spec catalogue.
  // Note: the filter is `--reads` (not `--read-only`) because `--read-only` is
  // a GLOBAL write-lock flag; reusing the name here would be ambiguous.
  program
    .command("commands")
    .argument(
      "[domain]",
      "Only commands in this domain — the token after `ib` (e.g. keikka)"
    )
    .option("--mutations")
    .option("--reads")
    .option(
      "--permission <substr>"
    )
    .option("--find <text>")
    .option("--all")
    .action(
      guarded((
        domain: string | undefined,
        opts: {
          mutations?: boolean;
          reads?: boolean;
          permission?: string;
          find?: string;
          all?: boolean;
        }
      ) => {
        // Bare `ib commands` = cheap domain index; any narrowing argument
        // (domain, filter flag, or explicit --all) = flat leaf list.
        const wantsFlatList =
          opts.all ||
          domain ||
          opts.mutations ||
          opts.reads ||
          opts.permission !== undefined ||
          opts.find !== undefined;
        writeJson(
          wantsFlatList
            ? buildCommandsList({
                domain,
                mutations: opts.mutations,
                reads: opts.reads,
                permission: opts.permission,
                find: opts.find,
              })
            : buildDomainIndex()
        );
      })
    );

  // Replace each subcommand's `--help` with its rich CommandSpec rendering.
  attachRichHelp(program, COMMAND_SPECS);

  return program;
}

/**
 * Resolve the running command's `CommandSpec.errors` and stash them so error
 * envelopes can echo the command's OWN documented remedy as `hint` (feedback
 * #25). Walks the command up its `.parent` chain to reconstruct the full
 * space-joined command path, matches it against {@link COMMAND_SPECS}, and
 * sets the active errors (`null` when no spec matches → generic hints only).
 *
 * Shared by `bin/ib.ts` and `runArgv` so both resolve hints identically — the
 * path-join logic must NOT drift between the two entry points.
 */
export function applySpecErrors(actionCommand: Command): void {
  const spec = specFor(actionCommand);
  setActiveCommandErrors(spec?.errors ?? null);
  setListColumns(spec?.prettyColumns ?? null);
}

/**
 * The command's own `CommandSpec`, or `undefined` when none matches. Shared by
 * {@link applySpecErrors} (preAction) and {@link handleParseRejection}'s
 * parse-time branch so the two resolve the SAME spec for the same command.
 *
 * canonicalPath so invoking a back-compat alias still resolves the command's
 * OWN documented remedies; without it hintForError fell back to the generic
 * per-status hint on every aliased path.
 */
function specFor(cmd: Command): CommandSpec | undefined {
  const path = canonicalPath(commandPath(cmd));
  return COMMAND_SPECS.find((s) => s.command === path);
}

/**
 * Reject a flag whose value is another FLAG NAME that arrived as the next
 * separate token — the signature of an empty-string argument eaten by the shell.
 *
 * Windows PowerShell 5.1 DROPS an empty-string argument to a native exe, so the
 * documented clear syntax `--email ""` reaches us as `--email <next-token>`.
 * Whether that is loud depends entirely on what followed, which is why it cannot
 * be left to the parser:
 *
 *  - next token is a ROOT global (`--pretty`) → Commander refuses to consume a
 *    known option as an option-argument and errors "argument missing". LOUD.
 *  - next token leaves a positional stranded (`--email "" --asiakas 1380`) →
 *    excess-arguments error, the shape fb#634 was filed from. LOUD.
 *  - next token is a LOCAL flag or a bare word → consumed as the value, and
 *    NOTHING fails. `--reason "" --dry-run` yields `reason: "--dry-run"` with the
 *    dry-run silently swallowed: a rehearsal becomes a real write whose audit
 *    reason is a flag name. `--email "" --dry-run` likewise persists the literal
 *    string "--dry-run" into the field the caller meant to clear.
 *
 * That last row is what this guard exists for; the loud rows already read well
 * (buildExcessArgumentsEnvelope carries the hint). fb#634 — same corruption class
 * as the eaten backtick in fb#552, but on a write path and worth failing rather
 * than warning, since the caller's intent (clear the field) definitely will not
 * happen either way.
 *
 * Deliberately narrow, because a false positive would block a legitimate value:
 * the value must EXACTLY equal a flag name reachable on this invocation, AND the
 * two must be adjacent separate tokens in argv. The adjacency half is what keeps
 * `--command=--dry-run` a legal literal — an escape hatch that costs nothing,
 * since the equals form is also the fix we point callers at.
 */
export function assertNoEatenEmptyString(program: Command, actionCommand: Command): void {
  // `rawArgs` is set by Commander's parse() on the root program but is absent
  // from its public typings; narrow cast rather than `any`. Missing (a direct
  // action() call in a test) simply disables the guard.
  const rawArgs = (program as unknown as { rawArgs?: string[] }).rawArgs;
  if (!rawArgs?.length) return;

  // Every option name legal ANYWHERE in this argv: the command's own plus the
  // root globals (which Commander accepts at any position).
  const optionNames = new Set<string>();
  for (const cmd of [actionCommand, program]) {
    for (const o of cmd.options) {
      if (o.long) optionNames.add(o.long);
      if (o.short) optionNames.add(o.short);
    }
  }

  const opts = actionCommand.opts();
  for (const o of actionCommand.options) {
    const value = opts[o.attributeName()];
    if (typeof value !== "string" || !optionNames.has(value)) continue;
    const spellings = [o.long, o.short].filter((s): s is string => !!s);
    const adjacent = rawArgs.some((tok, i) => spellings.includes(tok) && rawArgs[i + 1] === value);
    if (!adjacent) continue;
    const flag = o.long ?? o.short ?? o.attributeName();
    failWith(
      `${flag} received the literal value '${value}', which is another option name. ` +
        `On Windows PowerShell an empty-string argument is DROPPED, so \`${flag} ""\` becomes \`${flag} ${value}\` ` +
        `and ${value} is silently swallowed. To CLEAR the field use the equals form: \`${flag}=\` ` +
        `(it means the same thing in bash, so it is the one syntax that works everywhere). ` +
        `To pass this literal value on purpose: \`${flag}=${value}\`. See \`ib help shell-quoting\`.`,
      4
    );
  }
}

/**
 * Enforce a spec-declared `--reason` requirement ({@link CommandSpec.reasonPolicy})
 * before the action runs. Installed as a preAction hook by `buildProgram`, so
 * EVERY consumer of the built tree (bin, runArgv, tests) gets the guard — the
 * declaration lives in the spec instead of a hand-called `requireReason` in
 * each action (~44 sites, where a new write command could silently omit it).
 * `failWith` from a hook propagates to the CliError-aware catch either way —
 * same envelope, same exit 4 as the in-action call it replaces.
 */
export function enforceSpecReasonPolicy(actionCommand: Command): void {
  const path = canonicalPath(commandPath(actionCommand));
  const spec = COMMAND_SPECS.find((s) => s.command === path);
  if (!spec?.reasonPolicy) return;
  requireReason(actionCommand.opts(), {
    allowDryRun: spec.reasonPolicy === "unless-dry-run",
    detail: spec.reasonDetail,
  });
}

/**
 * Make every command in the tree THROW a CommanderError instead of calling
 * `process.exit()` for usage errors / help / version, and capture the parser's
 * stderr text (the "error: unknown command …" line, did-you-mean suggestions,
 * error-triggered help renders). Two reasons:
 *
 *  1. Usage errors can then be emitted as the standard JSON error envelope
 *     by {@link handleParseRejection} instead of parser plain text — the last
 *     non-envelope error path (feedback #24).
 *  2. Commander's internal `process.exit()` disappears (Windows-unsafe after
 *     a completed fetch — libuv UV_HANDLE_CLOSING assert, exit 127).
 *
 * Returns a getter for the captured stderr text. Must be called AFTER the
 * tree is fully built (exitOverride/configureOutput don't propagate to
 * already-created subcommands via inheritance — we walk explicitly).
 */
export interface ParserHooks {
  /** Accumulated parser stderr text (help renders, did-you-mean lines, etc.). */
  parserText: () => string;
  /** The command that last called _exit — the GROUP for an unknown subcommand. */
  erroringCommand: () => Command | null;
  /**
   * The deepest command parse dispatched INTO, recorded before that command
   * parses its own options — so it is known even when an option/argument
   * `argParser` throws (feedback #385). `null` until the first dispatch.
   */
  dispatchedCommand: () => Command | null;
}

export function enableParserThrow(program: Command): ParserHooks {
  let captured = "";
  let erroringCmd: Command | null = null;
  let dispatchedCmd: Command | null = null;
  const walk = (cmd: Command): void => {
    const output = {
      writeErr: (s: string) => {
        captured += s;
      },
      // Commander writes --help / --version display through writeOut. Route it
      // through the ctx-aware emitStdout so in-process (embedded) `ib … --help`
      // is captured into ctx.stdout instead of leaking to the real stdout. In
      // normal CLI mode emitStdout falls back to process.stdout — unchanged.
      //
      // DROPPED for the fb#615 case (fb#628): Commander renders the group's help
      // BEFORE it can reject the unknown operand, so that call exited 4 with the
      // envelope on stderr and help prose on stdout — the exit code said failure
      // while stdout said otherwise. Suppressed at the write, per command, which
      // is why `output` is built inside the walk: a single shared object cannot
      // tell WHICH command is writing. The alternative — buffering every
      // Commander stdout write and flushing conditionally — would have silently
      // swallowed the manual `glossary.outputHelp()` call, which never throws and
      // so would never reach a flush point.
      writeOut: (s: string) => {
        if (unknownLeafToken(cmd)) return;
        emitStdout(s);
      },
    };
    // A callback that closes over `cmd` captures WHICH command threw, then
    // throws (Windows-safe: never reaches Commander's internal process.exit).
    cmd.exitOverride((err) => {
      erroringCmd = cmd;
      throw err;
    });
    // Commander runs a command's OWN preSubcommand hooks (never an ancestor's),
    // so the hook is registered per command — each dispatch overwrites the
    // pointer and the last one to win is the leaf. Fires BEFORE the subcommand
    // parses its options, which is the only place an argParser throw can be
    // attributed from: that throw is not a CommanderError, so `exitOverride`
    // never runs and `erroringCommand` stays null (feedback #385).
    cmd.hook("preSubcommand", (_parent, sub) => {
      dispatchedCmd = sub;
    });
    cmd.configureOutput(output);
    cmd.commands.forEach(walk);
  };
  walk(program);
  return {
    parserText: () => captured,
    erroringCommand: () => erroringCmd,
    dispatchedCommand: () => dispatchedCmd,
  };
}

/** Commander's error shape under exitOverride (avoid instanceof across copies). */
interface CommanderErrorLike {
  code?: string;
  exitCode?: number;
  message?: string;
}

function isCommanderError(err: unknown): err is CommanderErrorLike {
  return (
    typeof err === "object" &&
    err !== null &&
    typeof (err as CommanderErrorLike).code === "string" &&
    (err as CommanderErrorLike).code!.startsWith("commander.")
  );
}

/**
 * Is `token` a subcommand registered on `cmd` — by name OR by any alias?
 *
 * Registration, deliberately NOT tier visibility: a tier-hidden leaf still
 * parses and executes (hiding is discovery secrecy, not access control — see
 * CLAUDE.md), so reporting one as unknown would contradict that and tell the
 * caller a command they can actually run does not exist.
 */
function isRegisteredSubcommand(cmd: Command, token: string): boolean {
  return cmd.commands.some((c) => c.name() === token || c.aliases().includes(token));
}

/**
 * Does `cmd` have a DEFAULT subcommand (a child registered `{ isDefault: true }`)?
 *
 * Commander records this as `_defaultCommandName` on the PARENT. Private, but
 * the behaviour it gates is exactly what we must mirror: in `_parseCommand`,
 * `if (this._defaultCommandName) { this._outputHelpIfRequested(unknown); return
 * this._dispatchSubcommand(...) }` — so on such a group an UNREGISTERED token is
 * never "unknown", it is the default leaf's argument, and rendering the parent's
 * help for `--help` is deliberate ("Run the help for default command from parent
 * rather than passing to default command").
 *
 * `ib glossary` is the only such group today (`lookup [term]`, isDefault), which
 * is what makes `ib glossary puomi --help` legitimate: `puomi` is a TERM. The
 * behaviour, not this field, is pinned by test — so a Commander upgrade that
 * renames the field fails loudly instead of silently re-breaking it.
 */
function hasDefaultSubcommand(cmd: Command): boolean {
  return Boolean((cmd as unknown as { _defaultCommandName?: string | null })._defaultCommandName);
}

/**
 * The unknown-leaf token this command is about to render help for, or null.
 *
 * Shared by the two halves of the fb#615 fix so they can never disagree: the
 * exit-4 envelope in {@link handleParseRejection}, and the stdout suppression in
 * {@link enableParserThrow} (fb#628). Both need the SAME answer — emitting the
 * envelope while still printing the help, or vice versa, is worse than either.
 */
function unknownLeafToken(cmd: Command | null): string | null {
  // A leaf's own positionals are not subcommands (`ib reference detail get
  // keikka list --help`), and a default-command group's are its argument.
  if (!cmd || cmd.commands.length === 0 || hasDefaultSubcommand(cmd)) return null;
  const token = String((cmd.args ?? [])[0] ?? "");
  if (!token || token.startsWith("-") || isRegisteredSubcommand(cmd, token)) return null;
  return token;
}

/**
 * `ib <group> <unknown-leaf> --help` → the unknown-command envelope, exit 4
 * (fb#615). Returns null when this rejection is an ordinary help/version
 * display.
 *
 * Commander resolves `--help` on the GROUP before it ever rejects the unknown
 * operand, so this branch used to exit 0 after printing the group's help. Two
 * costs, both real: `--help` could not be used for capability detection, and —
 * worse — the exit-0-plus-help-text reads as CONFIRMATION that the leaf exists.
 * Against a stale/vendored binary lacking a newer leaf that is a false positive
 * that sends a whole verification run at a build without the command. The same
 * argv WITHOUT `--help` already exits 4, so the two disagreed about the same
 * input; asking for help about a nonexistent command is a usage error either
 * way. Scoped by {@link unknownLeafToken}, which excludes a leaf's own
 * positionals and default-command groups.
 */
function unknownLeafHelpEnvelope(cmd: Command | null): UnknownCommandEnvelope | null {
  const token = unknownLeafToken(cmd);
  return cmd && token ? buildUnknownCommandEnvelope(cmd, token, getCallerTier()) : null;
}

function missingMandatoryOptions(cmd: Command): string[] {
  const missing: string[] = [];
  for (let c: Command | null = cmd; c; c = c.parent) {
    for (const option of c.options as Option[]) {
      if (option.mandatory && c.getOptionValue(option.attributeName()) === undefined) {
        missing.push(option.flags);
      }
    }
  }
  return missing;
}

/** Extract the long flag from a Commander flags string: `-t, --type <t>` → `--type`. */
function longFlag(flags: string): string {
  const m = flags.match(/--[a-zA-Z0-9][\w-]*/);
  return m ? m[0] : flags.split(/\s+/)[0];
}

/**
 * Terminal path shared by every `commander.*` usage-error branch below: emit the
 * envelope on stderr, record the friction, exit 4. The friction string is what
 * was DISPLAYED (error + hint), not Commander's bare internal message — the
 * groomer only sees this log, and a bare `unknown command 'x'` reads as "no
 * pointer was given" (fb#275).
 */
function emitUsageEnvelope<T extends { error: string; hint: string }>(
  err: unknown,
  env: T
): void {
  writeErrorEnvelope(env, 4);
  recordFriction(err, 4, `${env.error} — ${env.hint}`);
  setExit(4);
}

/**
 * Terminal handler for `program.parseAsync(...).catch(...)`. Never calls
 * `process.exit()` (Windows-unsafe post-fetch) — sets `process.exitCode` and
 * lets the loop drain. Routing:
 *
 *  - CliError (failWith guards / global-option validation thrown outside any
 *    action try-block) → stderr envelope + its mapped exit code, with the
 *    dispatched command's spec ERRORS resolved first so a PARSE-time guard gets
 *    the same `hint` an in-action one does (feedback #385).
 *  - Commander help/version display (exitCode 0) → pass any captured text
 *    through, exit 0.
 *  - `commander.help` (help auto-rendered for a bare `ib` / bare group, exit
 *    1) → pass the captured help text through unchanged, keep exit 1 — that
 *    output is help, not an error.
 *  - Any other commander.* (unknown command/flag, missing argument/option,
 *    excess args) → JSON envelope with code "USAGE" and exit 4 (validation):
 *    usage errors ARE validation errors, and agents get one uniform error
 *    surface.
 *  - Anything else → plain message, exit 1 (unexpected runtime failure).
 */
export function handleParseRejection(
  err: unknown,
  hooks: Partial<ParserHooks> = {}
): void {
  const { parserText, erroringCommand, dispatchedCommand } = hooks;
  if (err instanceof CliError) {
    // A parse-time guard (an option/argument `argParser` calling `failWith`)
    // throws BEFORE the preAction hook that normally runs `applySpecErrors`, so
    // without this the whole parse-time class of client errors could never echo
    // its command's own ERRORS remedy — the spec rows were documentation-only at
    // runtime (feedback #385). Errors only: re-seeding prettyColumns here would
    // clobber an explicit `--columns` on the rare CliError that escapes an action.
    const cmd = dispatchedCommand?.();
    if (cmd) setActiveCommandErrors(specFor(cmd)?.errors ?? null);
    exitWithError(err);
    return;
  }
  if (isCommanderError(err)) {
    const text = parserText?.() ?? "";
    if (err.exitCode === 0 || err.code === "commander.help") {
      // Help ABOUT a command that does not exist is a usage error, not help
      // (fb#615) — checked before the pass-through so `--help` cannot report
      // success for a leaf this build does not have.
      const unknownLeaf = erroringCommand ? unknownLeafHelpEnvelope(erroringCommand()) : null;
      if (unknownLeaf) return emitUsageEnvelope(err, unknownLeaf);
      if (text) emitStderr(text);
      setExit(err.exitCode ?? 0);
      return;
    }
    // Unknown subcommand → enriched envelope: siblings + did-you-mean (#1).
    if (err.code === "commander.unknownCommand" && erroringCommand) {
      const cmd = erroringCommand();
      if (cmd) {
        const token =
          (Array.isArray(cmd.args) && cmd.args[0]) ||
          text.match(/unknown command '([^']+)'/)?.[1] ||
          "";
        return emitUsageEnvelope(err, buildUnknownCommandEnvelope(cmd, token, getCallerTier()));
      }
    }
    if (err.code === "commander.missingMandatoryOptionValue" && erroringCommand) {
      const cmd = erroringCommand();
      const missing = cmd ? missingMandatoryOptions(cmd) : [];
      // Emit the PRESCRIPTIVE envelope for any number of missing required flags
      // (previously only for >1): the caller gets every missing flag, its allowed
      // values (from the command spec), and a copy-paste sample in ONE response —
      // no `--help` round-trip, even for a single omitted flag (feedback #204).
      if (cmd && missing.length) {
        const path = commandPath(cmd);
        // Look the spec up by canonical path (so an alias still gets its allowed
        // values + sample), but keep `path` as INVOKED for the envelope — the
        // caller should see back the command they actually ran.
        const spec = COMMAND_SPECS.find((s) => s.command === canonicalPath(path));
        const problems: FlagProblem[] = missing.map((f) => ({
          flag: longFlag(f),
          issue: "missing",
        }));
        const envelope = buildValidationEnvelope(path, problems, { spec });
        // Commander reports the missing flag BEFORE excess positionals, so a
        // caller who made both mistakes at once would never see the date hint
        // (feedback #328 follow-up — same masking shape as fb#309). Fold it in
        // rather than making them fix one error to discover the next.
        const dateHint = dateFlagSuggestion(cmd, excessPositionals(cmd));
        if (dateHint) {
          const base = (envelope.hint ?? "").trim().replace(/[.\s]*$/, "");
          envelope.hint = `${base}. Also: a surplus positional looks like a date — pass it as \`${dateHint.suggestion}\`, not as a positional.`;
        }
        return emitUsageEnvelope(err, envelope);
      }
    }
    // Unknown option → enriched envelope: the command's real positionals + flags,
    // a fuzzy did-you-mean among its actual flags, and any curated cross-command
    // redirect (feedback #235/#236 — the flag analogue of the unknown-command path).
    if (err.code === "commander.unknownOption" && erroringCommand) {
      const cmd = erroringCommand();
      const token =
        text.match(/unknown option '([^']+)'/)?.[1] ||
        err.message?.match(/unknown option '([^']+)'/)?.[1] ||
        "";
      if (cmd && token) {
        return emitUsageEnvelope(err, buildUnknownOptionEnvelope(cmd, token, getCallerTier()));
      }
    }
    const detail = (text || err.message || "usage error")
      .replace(/^error:\s*/gm, "")
      .trim();
    // Excess positionals → name what was probably meant. Chiefly a date typed
    // positionally on an `<id> --date` command (feedback #328); Commander's own
    // message lists the surplus tokens but never points at the flag.
    if (err.code === "commander.excessArguments" && erroringCommand) {
      const cmd = erroringCommand();
      if (cmd) {
        const excess = excessPositionals(cmd);
        if (excess.length) {
          return emitUsageEnvelope(err, buildExcessArgumentsEnvelope(cmd, excess, detail));
        }
      }
    }
    const genericHint =
      "usage error — run `ib <command> --help` for the exact arguments and flags, or `ib commands` to discover commands";
    return emitUsageEnvelope(err, {
      success: false,
      error: detail,
      code: "USAGE",
      statusCode: 0,
      hint: genericHint,
    });
  }
  const message = errorMessage(err);
  recordFriction(err, 1);
  emitStderr(`${message}\n`);
  setExit(1);
}
