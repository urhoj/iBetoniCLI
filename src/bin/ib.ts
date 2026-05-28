#!/usr/bin/env node
import { Command } from "commander";
import packageJson from "../../package.json" with { type: "json" };

const program = new Command();
program
  .name("ib")
  .description("iBetoni CLI — AI-driven command-line interface for betoni.online")
  .version(packageJson.version);

// Commands wired in subsequent tasks.

program.parseAsync(process.argv).catch((err) => {
  process.stderr.write(`${err.message || err}\n`);
  process.exit(1);
});
