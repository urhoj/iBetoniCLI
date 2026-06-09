import { writeJson, exitWithError } from "../../output/json.js";
import { explainRole } from "../../roles.js";
/**
 * `ib role` — inspect betoni.online role definitions.
 *
 * `explain` resolves typeId/tiers/deprecation OFFLINE from @ibetoni/constants,
 * then enriches with the LIVE DB description + comment via the authenticated
 * GET /api/asiakasPersonSettings/getAllTypes — so it now takes the `getClient`
 * factory and requires auth (exits 2 "Not logged in" when unauthenticated).
 * The network/transform logic stays in `explainRole` (src/roles.ts), keeping
 * this action thin and testable against a mock ApiClient.
 */
export function registerRoleCommands(program, getClient) {
    const role = program
        .command("role")
        .description("Inspect betoni.online role definitions (tiers from @ibetoni/constants, description/comment from the DB)");
    role
        .command("explain <name>")
        .description("Explain a role name: typeId, display name, DB description/comment, access tiers, deprecation")
        .action(async (name) => {
        try {
            const client = await getClient();
            writeJson(await explainRole(client, name));
        }
        catch (e) {
            exitWithError(e);
        }
    });
}
//# sourceMappingURL=index.js.map