import { writeJson, exitWithError } from "../../output/json.js";
import { decodeJwtPayload } from "../../auth/jwt.js";
import { CliError } from "../../api/errors.js";
/** GET /api/validation/profiles → ListEnvelope. */
export async function runValidateProfiles(client) {
    const items = await client.get("/api/validation/profiles");
    return { items, nextCursor: null, count: items.length };
}
/** GET /api/validation/:profile/:asiakasId — server-evaluated checklist. */
export async function runValidate(client, profile, asiakasId) {
    if (!Number.isInteger(asiakasId) || asiakasId < 1) {
        throw new CliError("--asiakas must be a positive integer", 0, null, 4);
    }
    return client.get(`/api/validation/${encodeURIComponent(profile)}/${asiakasId}`);
}
/**
 * Register `ib validate [profile]` — company-setup validation profiles.
 * Bare `ib validate` (or the reserved word `list`) lists profiles; with a
 * profile id it runs the server-side checklist. The profile string is passed
 * through, so future server-side profiles need zero CLI changes.
 * Deploy-gated: 404 until /api/validation is deployed.
 */
export function registerValidateCommands(parent, getClient) {
    parent
        .command("validate [profile]")
        .description("Run a company-setup validation profile (jerry, betoni); omit profile or use 'list' to list profiles")
        .option("--asiakas <id>", "Target asiakasId (default: active company)", Number)
        .action(async (profile, opts) => {
        try {
            const client = await getClient();
            if (!profile || profile === "list") {
                writeJson(await runValidateProfiles(client));
                return;
            }
            const asiakasId = opts.asiakas ?? decodeJwtPayload(client.getCurrentToken()).ownerAsiakasId;
            writeJson(await runValidate(client, profile, asiakasId));
        }
        catch (e) {
            exitWithError(e);
        }
    });
}
//# sourceMappingURL=index.js.map