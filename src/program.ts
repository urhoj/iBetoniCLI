/**
 * Builds the fully-wired `ib` Commander program.
 *
 * Extracted from `bin/ib.ts` so the entire command tree — including the rich
 * `--help` wiring — is importable by tests without triggering argv parsing.
 * `bin/ib.ts` is now just a thin shell: build, then `parseAsync`.
 */
import { Command } from "commander";
import packageJson from "../package.json" with { type: "json" };
import { addGlobalOptions, getGlobalOptions, type GlobalOptions } from "./globals.js";
import { defaultCredentialsPath } from "./auth/store.js";
import { createCliContext } from "./cliContext.js";
import type { ApiClient } from "./api/client.js";
import { registerAuthCommands } from "./commands/auth/index.js";
import { registerCompanyCommands } from "./commands/company/index.js";
import { registerKeikkaCommands } from "./commands/keikka/index.js";
import { registerCustomerCommands } from "./commands/customer/index.js";
import { registerWorksiteCommands } from "./commands/worksite/index.js";
import { registerPersonCommands } from "./commands/person/index.js";
import { registerRoleCommands } from "./commands/role/index.js";
import { registerVehicleCommands } from "./commands/vehicle/index.js";
import { registerDriverCommands } from "./commands/driver/index.js";
import { registerSijaintiCommands } from "./commands/sijainti/index.js";
import { registerOhjeCommands } from "./commands/ohje/index.js";
import { registerJerryCommands } from "./commands/jerry/index.js";
import { registerScheduleCommands } from "./commands/schedule/index.js";
import { registerStatsCommands } from "./commands/stats/index.js";
import { registerChangesCommands } from "./commands/changes/index.js";
import { registerSearchCommands } from "./commands/search/index.js";
import { registerAttachmentCommands } from "./commands/attachment/index.js";
import { registerSchemaCommands } from "./commands/schema/index.js";
import { registerCacheCommands } from "./commands/cache/index.js";
import { registerWeatherCommands } from "./commands/weather/index.js";
import { registerFeedbackCommands } from "./commands/feedback/index.js";
import { registerHelpCommands } from "./commands/help/index.js";
import { registerVersionCommand } from "./commands/version/index.js";
import { registerDoctorCommand } from "./commands/doctor/index.js";
import { runReferenceDump } from "./reference/dump.js";
import { buildCommandsList, buildDomainIndex } from "./reference/commandsList.js";
import { renderDomainHelp } from "./reference/domain.js";
import { attachRichHelp } from "./output/help.js";
import { COMMAND_SPECS } from "./reference/specs.js";
import { writeJson, exitWithError, failWith } from "./output/json.js";
import { CliError } from "./api/errors.js";

/**
 * Construct the `ib` program with all subcommands registered and rich
 * (`CommandSpec`-driven) `--help` attached. Does not parse argv.
 */
export function buildProgram(): Command {
  const program = new Command();
  program
    .name("ib")
    .description("iBetoni CLI — AI-driven command-line interface for betoni.online")
    .version(packageJson.version);
  // Domain primer (what betoni.online is + glossary) on the root `--help`, so an
  // AI inspecting top-level help gets the same context `ib reference dump`
  // embeds. Sourced from reference/domain.ts — one source of truth, no drift.
  program.addHelpText("after", renderDomainHelp());
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

  const getClient = (): Promise<ApiClient> =>
    clientFrom(getGlobalOptions(program));

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

  // `help` — offline concept guides, no auth. Registered before authenticated
  // commands so the spec catalogue and wiring tests can find it.
  registerHelpCommands(program);

  // `role explain` resolves tiers offline (@ibetoni/constants) but reads the DB
  // description/comment via an authenticated GET, so it needs the client.
  registerRoleCommands(program, getClient);

  registerCompanyCommands(program, getClient, isReadOnly);
  registerKeikkaCommands(program, getClient);
  registerCustomerCommands(program, getClient);
  registerWorksiteCommands(program, getClient);
  registerPersonCommands(program, getClient, getClientForAsiakas);
  registerVehicleCommands(program, getClient);
  registerDriverCommands(program, getClient);
  registerSijaintiCommands(program, getClient);
  registerOhjeCommands(program, getClient);
  registerJerryCommands(program, getClient);
  registerScheduleCommands(program, getClient);
  registerStatsCommands(program, getClient);
  registerChangesCommands(program, getClient);
  registerSchemaCommands(program, getClient);
  registerCacheCommands(program, getClient);
  registerWeatherCommands(program, getClient);
  registerFeedbackCommands(program, getClient);
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

  const reference = program
    .command("reference")
    .description("Reference / meta commands (machine-readable CLI catalogue)");
  reference
    .command("dump")
    .description("Emit the full command surface as JSON on stdout")
    .argument(
      "[domain]",
      "Restrict the commands map to one domain — the token after `ib` (e.g. keikka)"
    )
    .action((domain?: string) => {
      try {
        runReferenceDump(domain);
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
              ? buildCommandsList({
                  domain,
                  mutations: opts.mutations,
                  reads: opts.reads,
                  permission: opts.permission,
                })
              : buildDomainIndex()
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
export function enableParserThrow(program: Command): () => string {
  let captured = "";
  const output = {
    writeErr: (s: string) => {
      captured += s;
    },
  };
  const walk = (cmd: Command): void => {
    cmd.exitOverride();
    cmd.configureOutput(output);
    cmd.commands.forEach(walk);
  };
  walk(program);
  return () => captured;
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
  parserText: () => string
): void {
  if (err instanceof CliError) {
    exitWithError(err);
    return;
  }
  if (isCommanderError(err)) {
    const text = parserText();
    if (err.exitCode === 0 || err.code === "commander.help") {
      if (text) process.stderr.write(text);
      process.exitCode = err.exitCode ?? 0;
      return;
    }
    const detail = (text || err.message || "usage error")
      .replace(/^error:\s*/gm, "")
      .trim();
    process.stderr.write(
      JSON.stringify({
        success: false,
        error: detail,
        code: "USAGE",
        statusCode: 0,
        hint: "usage error — run `ib <command> --help` for the exact arguments and flags, or `ib commands` to discover commands",
      }) + "\n"
    );
    process.exitCode = 4;
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
