/**
 * Builds the fully-wired `ib` Commander program.
 *
 * Extracted from `bin/ib.ts` so the entire command tree — including the rich
 * `--help` wiring — is importable by tests without triggering argv parsing.
 * `bin/ib.ts` is now just a thin shell: build, then `parseAsync`.
 */
import { Command } from "commander";
import packageJson from "../package.json" with { type: "json" };
import { addGlobalOptions, getGlobalOptions } from "./globals.js";
import { defaultCredentialsPath } from "./auth/store.js";
import { createCliContext } from "./cliContext.js";
import type { ApiClient } from "./api/client.js";
import { registerAuthCommands } from "./commands/auth/index.js";
import { registerCompanyCommands } from "./commands/company/index.js";
import { registerKeikkaCommands } from "./commands/keikka/index.js";
import { registerCustomerCommands } from "./commands/customer/index.js";
import { registerWorksiteCommands } from "./commands/worksite/index.js";
import { registerPersonCommands } from "./commands/person/index.js";
import { registerVehicleCommands } from "./commands/vehicle/index.js";
import { registerSijaintiCommands } from "./commands/sijainti/index.js";
import { registerOhjeCommands } from "./commands/ohje/index.js";
import { registerJerryCommands } from "./commands/jerry/index.js";
import { registerScheduleCommands } from "./commands/schedule/index.js";
import { registerSchemaCommands } from "./commands/schema/index.js";
import { registerWeatherCommands } from "./commands/weather/index.js";
import { registerVersionCommand } from "./commands/version/index.js";
import { runReferenceDump } from "./reference/dump.js";
import { buildCommandsList } from "./reference/commandsList.js";
import { renderDomainHelp } from "./reference/domain.js";
import { attachRichHelp } from "./output/help.js";
import { COMMAND_SPECS } from "./reference/specs.js";
import { writeJson, exitWithError } from "./output/json.js";

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

  async function getClient(): Promise<ApiClient> {
    const ctx = await createCliContext({
      credentialsPath: defaultCredentialsPath(),
      version: packageJson.version,
      global: getGlobalOptions(program),
    });
    if (!ctx.client) {
      process.stderr.write("Not logged in. Run `ib auth login` first.\n");
      process.exit(2);
    }
    return ctx.client;
  }

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

  // `auth` manages credential-store access directly (login/logout/whoami/etc.)
  // and so doesn't take a `getClient` factory.
  registerAuthCommands(program);

  registerCompanyCommands(program, getClient);
  registerKeikkaCommands(program, getClient);
  registerCustomerCommands(program, getClient);
  registerWorksiteCommands(program, getClient);
  registerPersonCommands(program, getClient);
  registerVehicleCommands(program, getClient);
  registerSijaintiCommands(program, getClient);
  registerOhjeCommands(program, getClient);
  registerJerryCommands(program, getClient);
  registerScheduleCommands(program, getClient);
  registerSchemaCommands(program, getClient);
  registerWeatherCommands(program, getClient);
  registerVersionCommand(program, packageJson.version, getEndpoint);

  const reference = program
    .command("reference")
    .description("Reference / meta commands (machine-readable CLI catalogue)");
  reference
    .command("dump")
    .description("Emit the full command surface as JSON on stdout")
    .action(() => {
      runReferenceDump();
    });

  // `ib commands` — filtered, offline discovery over the same spec catalogue.
  // Note: the filter is `--reads` (not `--read-only`) because `--read-only` is
  // a GLOBAL write-lock flag; reusing the name here would be ambiguous.
  program
    .command("commands")
    .description("Filtered list of ib commands from the spec catalogue (offline)")
    .option("--mutations", "Only commands that write (carry write-safety flags)")
    .option("--reads", "Only read-only commands (no writes)")
    .option(
      "--permission <substr>",
      "Only commands whose required permissions contain this substring"
    )
    .action(
      (opts: { mutations?: boolean; reads?: boolean; permission?: string }) => {
        try {
          writeJson(
            buildCommandsList({
              mutations: opts.mutations,
              reads: opts.reads,
              permission: opts.permission,
            })
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
