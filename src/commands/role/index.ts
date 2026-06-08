import type { Command } from "commander";
import { writeJson, exitWithError } from "../../output/json.js";
import { explainRole } from "../../roles.js";

/**
 * `ib role` — inspect betoni.online role definitions. OFFLINE: every subcommand
 * reads only @ibetoni/constants (no network, no auth), so this registrar takes
 * no `getClient` factory (like the `auth` group). Keeping the transform pure in
 * `explainRole` (src/roles.ts) means the action stays thin and testable.
 */
export function registerRoleCommands(program: Command): void {
  const role = program
    .command("role")
    .description(
      "Inspect betoni.online role definitions (offline, from @ibetoni/constants)"
    );

  role
    .command("explain <name>")
    .description(
      "Explain a role name: typeId, display name, access tiers, deprecation"
    )
    .action((name: string) => {
      try {
        writeJson(explainRole(name));
      } catch (e) {
        exitWithError(e);
      }
    });
}
