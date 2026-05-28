#!/usr/bin/env node
import { Command } from "commander";
import packageJson from "../../package.json" with { type: "json" };
import { registerAuthCommands } from "../commands/auth/index.js";

const program = new Command();
program
  .name("ib")
  .description("iBetoni CLI — AI-driven command-line interface for betoni.online")
  .version(packageJson.version);

registerAuthCommands(program);

program.parseAsync(process.argv).catch((err) => {
  process.stderr.write(`${err.message || err}\n`);
  process.exit(1);
});
