#!/usr/bin/env node
import { Command } from "commander";
import packageJson from "../../package.json" with { type: "json" };
import { addGlobalOptions, getGlobalOptions } from "../globals.js";
import { defaultCredentialsPath } from "../auth/store.js";
import { createCliContext } from "../cliContext.js";
import type { ApiClient } from "../api/client.js";
import { registerAuthCommands } from "../commands/auth/index.js";
import { registerCompanyCommands } from "../commands/company/index.js";
import { registerKeikkaCommands } from "../commands/keikka/index.js";
import { registerCustomerCommands } from "../commands/customer/index.js";
import { registerWorksiteCommands } from "../commands/worksite/index.js";
import { registerPersonCommands } from "../commands/person/index.js";
import { registerVehicleCommands } from "../commands/vehicle/index.js";
import { registerSijaintiCommands } from "../commands/sijainti/index.js";
import { registerScheduleCommands } from "../commands/schedule/index.js";
import { runReferenceDump } from "../reference/dump.js";

const program = new Command();
program
  .name("ib")
  .description("iBetoni CLI — AI-driven command-line interface for betoni.online")
  .version(packageJson.version);
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
registerScheduleCommands(program, getClient);

const reference = program
  .command("reference")
  .description("Reference / meta commands (machine-readable CLI catalogue)");
reference
  .command("dump")
  .description("Emit the full command surface as JSON on stdout")
  .action(() => {
    runReferenceDump();
  });

program.parseAsync(process.argv).catch((err) => {
  process.stderr.write(`${err.message || err}\n`);
  process.exit(1);
});
