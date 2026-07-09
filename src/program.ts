/**
 * Builds the fully-wired `ib` Commander program.
 *
 * Extracted from `bin/ib.ts` so the entire command tree — including the rich
 * `--help` wiring — is importable by tests without triggering argv parsing.
 * `bin/ib.ts` is now just a thin shell: build, then `parseAsync`.
 */
import { Command, Help } from "commander";
import packageJson from "../package.json" with { type: "json" };
import { addGlobalOptions, getGlobalOptions, type GlobalOptions } from "./globals.js";
import { defaultCredentialsPath } from "./auth/store.js";
import { createCliContext } from "./cliContext.js";
import { recordFriction } from "./friction.js";
import type { ApiClient } from "./api/client.js";
import { registerAuthCommands } from "./commands/auth/index.js";
import { registerCompanyCommands } from "./commands/company/index.js";
import { registerValidateCommands } from "./commands/validate/index.js";
import { registerKeikkaCommands } from "./commands/keikka/index.js";
import { registerCustomerCommands } from "./commands/customer/index.js";
import { registerWorksiteCommands } from "./commands/worksite/index.js";
import { registerPersonCommands } from "./commands/person/index.js";
import { registerVehicleCommands } from "./commands/vehicle/index.js";
import { registerNotificationCommands } from "./commands/notification/index.js";
import { registerSijaintiCommands } from "./commands/sijainti/index.js";
import { registerOhjeCommands } from "./commands/ohje/index.js";
import { registerLegalCommands } from "./commands/legal/index.js";
import { registerJerryCommands } from "./commands/jerry/index.js";
import { registerMessageCommands } from "./commands/message/index.js";
import { registerScheduleCommands } from "./commands/schedule/index.js";
import { registerStatsCommands } from "./commands/stats/index.js";
import { registerPerfCommands } from "./commands/perf/index.js";
import { registerLogCommands } from "./commands/log/index.js";
import { registerSearchCommands } from "./commands/search/index.js";
import { registerAttachmentCommands } from "./commands/attachment/index.js";
import { registerSchemaCommands } from "./commands/schema/index.js";
import { registerCacheCommands } from "./commands/cache/index.js";
import { registerWeatherCommands } from "./commands/weather/index.js";
import { registerOpendataCommands } from "./commands/opendata/index.js";
import { registerChangelogCommands } from "./commands/changelog/index.js";
import { registerFeedbackCommands } from "./commands/feedback/index.js";
import { registerAiCommands } from "./commands/ai/index.js";
import { registerGlossaryCommands } from "./commands/glossary/index.js";
import { registerHelpCommands } from "./commands/help/index.js";
import { registerVersionCommand } from "./commands/version/index.js";
import { registerDoctorCommand } from "./commands/doctor/index.js";
import { registerInboxCommand } from "./commands/inbox/index.js";
import { registerImpersonationCommands } from "./commands/dev/impersonation/index.js";
import { runReferenceDump, fetchPrimerGlossary } from "./reference/dump.js";
import { runReferenceDetail, runReferenceDetailSet, runReferenceDetailList, runReferenceDetailEdit, runReferenceDetailDelete, runReferenceDetailLint } from "./reference/detail.js";
import { parseEditOp } from "./textEdit.js";
import { addWriteFlagsToCommand } from "./api/writeFlags.js";
import { assertAiConfidence, addAssessWriteFlags, addNeedsReviewFlags } from "./assess.js";
import { buildCommandsList, buildDomainIndex, fullyHiddenDomains, assertKnownDomain } from "./reference/commandsList.js";
import { renderDomainHelp } from "./reference/domain.js";
import { attachRichHelp, firstSentence } from "./output/help.js";
import { COMMAND_SPECS } from "./reference/specs.js";
import { writeJson, exitWithError, failWith, failUsage, emitStdout, emitStderr, setActiveCommandErrors } from "./output/json.js";
import { buildUnknownCommandEnvelope } from "./output/unknownCommand.js";
import { getEmbeddedCtx } from "./embedded.js";
import { createApiClient } from "./api/client.js";
import { CliError } from "./api/errors.js";
import { getCallerTier } from "./tier.js";

/**
 * Construct the `ib` program with all subcommands registered and rich
 * (`CommandSpec`-driven) `--help` attached. Does not parse argv.
 */
export function buildProgram(): Command {
  const program = new Command();
  program
    .name("ib")
    .description("iBetoni CLI — AI-driven command-line interface for betoni.online and betoniJerry")
    .version(packageJson.version);
  // Domain primer (what betoni.online is + glossary) on the root `--help`, so an
  // AI inspecting top-level help gets the same context `ib reference dump`
  // embeds. Sourced from reference/domain.ts — one source of truth, no drift.
  program.addHelpText("after", () => renderDomainHelp(getCallerTier()));
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

  // Build an authenticated client from a resolved set of global options. Exits 2
  // with "Not logged in" when no auth resolves — so command actions never deal
  // with the unauthenticated case. The two factories below differ only in the
  // global options they pass in.
  async function clientFrom(global: GlobalOptions): Promise<ApiClient> {
    const ctx = await createCliContext({
      credentialsPath: defaultCredentialsPath(),
      version: packageJson.version,
      global,
    });
    if (!ctx.client) {
      // throw (not process.exit) — safe post-fetch on Windows; lands in the
      // action's exitWithError catch (or the bin catch) as envelope + exit 2.
      failWith("Not logged in. Run `ib auth login` first.", 2);
    }
    return ctx.client;
  }

  const getClient = (): Promise<ApiClient> => {
    const embCtx = getEmbeddedCtx();
    if (embCtx) {
      return Promise.resolve(createApiClient({ endpoint: embCtx.endpoint, token: embCtx.token, version: packageJson.version, readOnly: embCtx.readOnly }));
    }
    return clientFrom(getGlobalOptions(program));
  };

  // A client bound to a SPECIFIC company via an ephemeral switch (never
  // persisted). Reuses the same tested switch path and inherits
  // read-only/endpoint/version. Powers `person search --my-companies` fan-out.
  const getClientForAsiakas = (asiakasId: number): Promise<ApiClient> =>
    clientFrom({ ...getGlobalOptions(program), asiakas: asiakasId });

  // Resolve the active endpoint WITHOUT requiring auth — `createCliContext`
  // returns a usable `endpoint` (--endpoint → active profile → default) even
  // when no credentials resolve. Powers `ib version`, which queries the public
  // `/api/version` and so must work logged out.
  async function getEndpoint(): Promise<string> {
    const ctx = await createCliContext({
      credentialsPath: defaultCredentialsPath(),
      version: packageJson.version,
      global: getGlobalOptions(program),
    });
    return ctx.endpoint;
  }

  // Disable Commander's built-in `help` command so `ib help [topic]` can
  // register our own offline concept-guide action without conflict.
  // `ib --help` (the --help OPTION) is unaffected and still renders the domain
  // primer via `program.addHelpText("after", renderDomainHelp())` above.
  program.helpCommand(false);

  // Session write-lock resolver, evaluated at action time (after argv parse).
  // Passed to commands that mutate OUTSIDE the API client (persisted company
  // switch) so read-only mode covers them too, and to `doctor` for reporting.
  const isReadOnly = (): boolean => getGlobalOptions(program).readOnly;

  // `auth` manages credential-store access directly (login/logout/whoami/etc.)
  // and so doesn't take a `getClient` factory.
  registerAuthCommands(program, isReadOnly);

  // `help` — concept guides + DB glossary fallback. Registered before
  // authenticated commands so the spec catalogue and wiring tests can find it.
  registerHelpCommands(program, getClient);

  registerCompanyCommands(program, getClient, isReadOnly);
  registerValidateCommands(program, getClient);
  registerKeikkaCommands(program, getClient);
  registerCustomerCommands(program, getClient);
  registerWorksiteCommands(program, getClient);
  registerPersonCommands(program, getClient, getClientForAsiakas);
  registerVehicleCommands(program, getClient);
  registerNotificationCommands(program, getClient);
  registerSijaintiCommands(program, getClient);
  registerOhjeCommands(program, getClient);
  registerLegalCommands(program, getClient);
  registerJerryCommands(program, getClient);
  registerMessageCommands(program, getClient);
  registerScheduleCommands(program, getClient);
  registerStatsCommands(program, getClient);
  registerLogCommands(program, getClient);
  // `ib opendata` (canonical) houses building + weather + prh. The top-level
  // `ib weather` is kept as a HIDDEN back-compat alias (runtime-only; absent
  // from spec-driven discovery and root --help).
  registerOpendataCommands(program, getClient);
  registerWeatherCommands(program, getClient, { hidden: true });
  registerGlossaryCommands(program, getClient);
  registerSearchCommands(program, getClient);
  registerAttachmentCommands(program, getClient);
  registerVersionCommand(program, packageJson.version, getEndpoint);
  registerDoctorCommand(
    program,
    getClient,
    getEndpoint,
    packageJson.version,
    isReadOnly
  );
  // `ib dev` — developer/maintainer meta umbrella. The 8 groups below are
  // canonical under `ib dev …`; their previous top-level paths stay registered
  // with { hidden: true } as runtime-only back-compat aliases (absent from
  // spec-driven discovery and root --help), mirroring `ib opendata`/`ib weather`.
  const dev = program
    .command("dev")
    .description(
      "Developer & maintainer tools — CLI feedback, changelog, perf, cache, schema, AI logs, operator inbox. Filing feedback is open to everyone."
    );
  registerFeedbackCommands(dev, getClient);
  registerChangelogCommands(dev, getClient);
  registerPerfCommands(dev, getClient);
  registerCacheCommands(dev, getClient);
  registerSchemaCommands(dev, getClient);
  registerAiCommands(dev, getClient);
  registerInboxCommand(dev, getClient);
  registerImpersonationCommands(dev, getClient);
  // Hidden back-compat aliases at the old top-level paths (still executable).
  registerFeedbackCommands(program, getClient, { hidden: true });
  registerChangelogCommands(program, getClient, { hidden: true });
  registerPerfCommands(program, getClient, { hidden: true });
  registerCacheCommands(program, getClient, { hidden: true });
  registerSchemaCommands(program, getClient, { hidden: true });
  registerAiCommands(program, getClient, { hidden: true });
  registerInboxCommand(program, getClient, { hidden: true });

  const reference = program
    .command("reference")
    .description("Reference / meta commands (machine-readable CLI catalogue)");
  reference
    .command("dump")
    .description("Emit the full command surface as JSON on stdout")
    .argument(
      "[domain...]",
      "Restrict the commands map to one or more domains — the token after `ib` (e.g. keikka). Multiple domains share a single primer."
    )
    .option(
      "--glossary",
      "Include the term+synonyms vocabulary index (DB fetch). Off by default to keep the dump small; look up definitions on demand with `ib glossary lookup`/`list`"
    )
    .option(
      "--commands-only",
      "Emit only { version, generatedAt, commonErrors, commands } — drop the overview/topics/feedbackGuidance primer (and skip the glossary fetch)"
    )
    .option(
      "--lean",
      "Drop each command's notes/seeAlso prose (keeps examples) — ~7.6k fewer tokens on the full surface; fetch the dropped prose per-command via `ib <command> --help`"
    )
    .action(
      async (
        domains: string[],
        opts: { glossary?: boolean; commandsOnly?: boolean; lean?: boolean }
      ) => {
        try {
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
        } catch (e) {
          exitWithError(e);
        }
      }
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
    .description(
      "On-demand business/AI context for one command (DB-backed via /api/cli/command-catalog); exit 5 if none"
    )
    .argument("<command...>", "Command path after `ib` (e.g. keikka latest)")
    .action(async (commandParts: string[]) => {
      try {
        const client = await getClient();
        writeJson(await runReferenceDetail(client, commandParts, getCallerTier()));
      } catch (e) {
        exitWithError(e);
      }
    });

  addNeedsReviewFlags(
    detail
      .command("list")
      .description(
        "List command-catalog entries, optionally ordered by stalest (DB-backed)"
      )
      .option("--stalest <n>", "Return up to N entries sorted by least-recently reviewed", (v: string) => Number(v))
      .option("--domain <d>", "Only commands in this ib domain (e.g. attachment) — narrows BEFORE --stalest")
      .option("--with-detail", "Include each entry's full detail text, folding the per-command `reference detail get` into one call (needs the backend deployed)")
  ).action(async (opts: { stalest?: number; domain?: string; withDetail?: boolean; needsReview?: boolean; maxConfidence?: number }) => {
    try {
      // Validate the domain offline (exit 4 on unknown) before any network call,
      // mirroring `ib commands <domain>`.
      if (opts.domain) assertKnownDomain(COMMAND_SPECS, opts.domain, getCallerTier());
      const client = await getClient();
      writeJson(await runReferenceDetailList(client, opts.stalest, opts.domain, opts.withDetail ?? false, opts.needsReview ?? false, opts.maxConfidence));
    } catch (e) {
      exitWithError(e);
    }
  });

  const detailSet = detail
    .command("set")
    .description(
      "Write summary and/or detail for one command in the command-catalog (developer only)"
    )
    .argument("<command...>", "Command path after `ib` (e.g. keikka latest)")
    .option("--summary <text>", "Short one-line summary stored in the catalog")
    .option("--detail <text>", "Full markdown business-context detail")
    .option("--field <name>", "Edit-mode target field: summary | detail (default detail)")
    .option("--replace <text>", "Edit mode: replace this literal text in the target field (exactly once unless --all)")
    .option("--with <text>", 'Replacement for --replace ("" deletes the matched text)')
    .option("--append <text>", "Edit mode: append text to the target field (verbatim)")
    .option("--prepend <text>", "Edit mode: prepend text to the target field (verbatim)")
    .option("--all", "With --replace: substitute every occurrence");
  addWriteFlagsToCommand(addAssessWriteFlags(detailSet)).action(
    async (
      commandParts: string[],
      opts: {
        summary?: string;
        detail?: string;
        aiConfidence?: number;
        needsHumanReview?: boolean;
        dryRun?: boolean;
        idempotencyKey?: string;
        reason?: string;
        field?: string;
        replace?: string;
        with?: string;
        append?: string;
        prepend?: string;
        all?: boolean;
      }
    ) => {
      const editOp = parseEditOp({
        replace: opts.replace, with: opts.with,
        append: opts.append, prepend: opts.prepend, all: opts.all,
      });
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
        if (!opts.dryRun && !opts.reason) failWith("Missing required flag: --reason", 4);
        try {
          const client = await getClient();
          writeJson(
            await runReferenceDetailEdit(client, commandParts, field, editOp, {
              dryRun: opts.dryRun, reason: opts.reason, idempotencyKey: opts.idempotencyKey,
            }, getCallerTier())
          );
        } catch (e) {
          exitWithError(e);
        }
        return;
      }
      assertAiConfidence(opts.aiConfidence);
      try {
        const client = await getClient();
        const result = await runReferenceDetailSet(
          client,
          commandParts,
          { summary: opts.summary, detail: opts.detail, aiConfidence: opts.aiConfidence, needsHumanReview: opts.needsHumanReview },
          {
            dryRun: opts.dryRun,
            idempotencyKey: opts.idempotencyKey,
            reason: opts.reason,
          },
          getCallerTier()
        );
        writeJson(result);
      } catch (e) {
        exitWithError(e);
      }
    }
  );

  // `delete` — prune one catalog row by its EXACT key. Deliberately NOT gated by
  // the command registry (unlike get/set): its purpose is removing orphans whose
  // command path no longer resolves. --reason required for a real delete.
  const detailDelete = detail
    .command("delete")
    .description(
      "Delete one command-catalog row by its exact key — prunes orphans of re-homed/removed commands (developer only)"
    )
    .argument("<command...>", "The exact stored command key after `ib` (e.g. ai conversation)");
  addWriteFlagsToCommand(detailDelete).action(
    async (
      commandParts: string[],
      opts: { dryRun?: boolean; idempotencyKey?: string; reason?: string }
    ) => {
      if (!opts.dryRun && !opts.reason) failWith("Missing required flag: --reason", 4);
      try {
        const client = await getClient();
        writeJson(
          await runReferenceDetailDelete(client, commandParts, {
            dryRun: opts.dryRun, idempotencyKey: opts.idempotencyKey, reason: opts.reason,
          })
        );
      } catch (e) {
        exitWithError(e);
      }
    }
  );

  // `lint` — audit the catalog for orphan rows (keys with no live command left
  // by a rename/re-home). Read-only (one GET + local diff); --strict is a CI gate.
  detail
    .command("lint")
    .description(
      "Audit the command-catalog for orphan rows — keys with no live command (re-homed/renamed leftovers); --strict for CI (developer only)"
    )
    .option("--strict", "Exit 1 if any orphan row exists (for CI)")
    .action(async (opts: { strict?: boolean }) => {
      try {
        const res = await runReferenceDetailLint(await getClient());
        writeJson(res);
        if (opts.strict && res.items.length > 0) process.exitCode = 1;
      } catch (e) {
        exitWithError(e);
      }
    });

  // `ib commands` — filtered, offline discovery over the same spec catalogue.
  // Note: the filter is `--reads` (not `--read-only`) because `--read-only` is
  // a GLOBAL write-lock flag; reusing the name here would be ambiguous.
  program
    .command("commands")
    .description("Domain index of ib commands; filters/--all for flat lists (offline)")
    .argument(
      "[domain]",
      "Only commands in this domain — the token after `ib` (e.g. keikka)"
    )
    .option("--mutations", "Only commands that write (carry write-safety flags)")
    .option("--reads", "Only read-only commands (no writes)")
    .option(
      "--permission <substr>",
      "Only commands whose required permissions contain this substring"
    )
    .option("--all", "Full flat list of every command (default is the domain index)")
    .action(
      (
        domain: string | undefined,
        opts: { mutations?: boolean; reads?: boolean; permission?: string; all?: boolean }
      ) => {
        try {
          // Bare `ib commands` = cheap domain index; any narrowing argument
          // (domain, filter flag, or explicit --all) = flat leaf list.
          const wantsFlatList =
            opts.all || domain || opts.mutations || opts.reads || opts.permission !== undefined;
          writeJson(
            wantsFlatList
              ? buildCommandsList(
                  {
                    domain,
                    mutations: opts.mutations,
                    reads: opts.reads,
                    permission: opts.permission,
                  },
                  getCallerTier()
                )
              : buildDomainIndex(undefined, getCallerTier())
          );
        } catch (e) {
          exitWithError(e);
        }
      }
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
  const parts: string[] = [];
  for (let c: Command | null = actionCommand; c; c = c.parent) parts.unshift(c.name());
  const spec = COMMAND_SPECS.find((s) => s.command === parts.join(" "));
  setActiveCommandErrors(spec?.errors ?? null);
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
}

export function enableParserThrow(program: Command): ParserHooks {
  let captured = "";
  let erroringCmd: Command | null = null;
  const output = {
    writeErr: (s: string) => {
      captured += s;
    },
    // Commander writes --help / --version display through writeOut. Route it
    // through the ctx-aware emitStdout so in-process (embedded) `ib … --help`
    // is captured into ctx.stdout instead of leaking to the real stdout. In
    // normal CLI mode emitStdout falls back to process.stdout — unchanged.
    writeOut: (s: string) => {
      emitStdout(s);
    },
  };
  const walk = (cmd: Command): void => {
    // A callback that closes over `cmd` captures WHICH command threw, then
    // throws (Windows-safe: never reaches Commander's internal process.exit).
    cmd.exitOverride((err) => {
      erroringCmd = cmd;
      throw err;
    });
    cmd.configureOutput(output);
    cmd.commands.forEach(walk);
  };
  walk(program);
  return { parserText: () => captured, erroringCommand: () => erroringCmd };
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

function setExit(code: number): void {
  const ctx = getEmbeddedCtx();
  if (ctx) ctx.exitCode = code;
  else process.exitCode = code;
}

/**
 * Terminal handler for `program.parseAsync(...).catch(...)`. Never calls
 * `process.exit()` (Windows-unsafe post-fetch) — sets `process.exitCode` and
 * lets the loop drain. Routing:
 *
 *  - CliError (failWith guards / global-option validation thrown outside any
 *    action try-block) → stderr envelope + its mapped exit code.
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
  parserText: () => string,
  erroringCommand?: () => Command | null
): void {
  if (err instanceof CliError) {
    exitWithError(err);
    return;
  }
  if (isCommanderError(err)) {
    const text = parserText();
    if (err.exitCode === 0 || err.code === "commander.help") {
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
        emitStderr(
          JSON.stringify(buildUnknownCommandEnvelope(cmd, token, getCallerTier())) + "\n"
        );
        recordFriction(err, 4);
        setExit(4);
        return;
      }
    }
    const detail = (text || err.message || "usage error")
      .replace(/^error:\s*/gm, "")
      .trim();
    emitStderr(
      JSON.stringify({
        success: false,
        error: detail,
        code: "USAGE",
        statusCode: 0,
        hint: "usage error — run `ib <command> --help` for the exact arguments and flags, or `ib commands` to discover commands",
      }) + "\n"
    );
    recordFriction(err, 4);
    setExit(4);
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  recordFriction(err, 1);
  emitStderr(`${message}\n`);
  setExit(1);
}
