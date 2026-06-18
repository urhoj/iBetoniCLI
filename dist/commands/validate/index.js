import { writeJson, exitWithError, failWith } from "../../output/json.js";
import { decodeJwtPayload } from "../../auth/jwt.js";
import { CliError } from "../../api/errors.js";
/** GET /api/validation/profiles → ListEnvelope (each row carries `entity`). */
export async function runValidateProfiles(client) {
    const items = await client.get("/api/validation/profiles");
    return { items, nextCursor: null, count: items.length };
}
/** GET /api/validation/:profile/:asiakasId — company checklist. */
export async function runValidateCompany(client, profile, asiakasId) {
    if (!Number.isInteger(asiakasId) || asiakasId < 1) {
        throw new CliError("--asiakas must be a positive integer", 0, null, 4);
    }
    return client.get(`/api/validation/${encodeURIComponent(profile)}/${asiakasId}`);
}
/** GET /api/validation/person/:profile/:asiakasId/:personId — employee checklist. */
export async function runValidatePerson(client, profile, asiakasId, personId) {
    if (!Number.isInteger(asiakasId) || asiakasId < 1) {
        throw new CliError("--asiakas must be a positive integer", 0, null, 4);
    }
    if (!Number.isInteger(personId) || personId < 1) {
        throw new CliError("--person must be a positive integer", 0, null, 4);
    }
    return client.get(`/api/validation/person/${encodeURIComponent(profile)}/${asiakasId}/${personId}`);
}
/**
 * Register the top-level `ib validate` command as a SINGLE LEAF (no subcommands,
 * so it renders a full leaf `--help` with a FLAGS section). The optional
 * positional `action` is `list` to list profiles; otherwise it runs flag-driven
 * validation. Entity is inferred from `--person`: present → person validation
 * (profile defaults to "onboarding"); absent → company validation (profile
 * required). Profile/entity mismatch is enforced server-side (404). Deploy-gated:
 * 404 until /api/validation/person is deployed.
 */
export function registerValidateCommands(parent, getClient) {
    parent
        .command("validate [action]")
        .description("Validate a company or a single employee against a profile (company: jerry|betoni; person: onboarding). Use 'list' to list profiles.")
        .option("--asiakas <id>", "Target asiakasId (default: active company)", Number)
        .option("--person <id>", "Validate this person as an employee of the company", Number)
        .option("--profile <p>", "Profile id (company: jerry|betoni; person: onboarding [default])")
        .option("--keikka <id>", "Validate this keikka against the reminders-drawer rules (alias of ib keikka validate <id>)", Number)
        .action(async (action, opts) => {
        try {
            const client = await getClient();
            if (opts.keikka != null) {
                const { runKeikkaValidate } = await import("../keikka/index.js");
                writeJson(await runKeikkaValidate(client, { keikkaId: opts.keikka }));
                return;
            }
            if (action === "list") {
                writeJson(await runValidateProfiles(client));
                return;
            }
            const asiakasId = opts.asiakas ??
                decodeJwtPayload(client.getCurrentToken()).ownerAsiakasId ??
                failWith("could not resolve asiakasId from the active token — pass --asiakas <id>", 4);
            if (opts.person != null) {
                writeJson(await runValidatePerson(client, opts.profile ?? "onboarding", asiakasId, opts.person));
                return;
            }
            if (!opts.profile) {
                throw new CliError("Company validation needs --profile (jerry | betoni). Run `ib validate list` to see profiles.", 0, null, 4);
            }
            writeJson(await runValidateCompany(client, opts.profile, asiakasId));
        }
        catch (e) {
            exitWithError(e);
        }
    });
}
//# sourceMappingURL=index.js.map