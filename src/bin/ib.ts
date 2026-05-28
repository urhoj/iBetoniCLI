#!/usr/bin/env node
import { Command } from "commander";
import packageJson from "../../package.json" with { type: "json" };
import { registerAuthCommands } from "../commands/auth/index.js";
import { runReferenceDump } from "../reference/dump.js";

const program = new Command();
program
  .name("ib")
  .description("iBetoni CLI — AI-driven command-line interface for betoni.online")
  .version(packageJson.version);

registerAuthCommands(program);

const reference = program
  .command("reference")
  .description("Reference commands (machine-readable CLI catalogue)");
reference
  .command("dump")
  .description("Emit the full command reference as JSON on stdout")
  .action(() => {
    runReferenceDump();
  });

program.parseAsync(process.argv).catch((err) => {
  process.stderr.write(`${err.message || err}\n`);
  process.exit(1);
});
