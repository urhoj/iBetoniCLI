import { listEnvelope } from "../../api/envelopes.js";
import { writeJson, failWith } from "../../output/json.js";
import { guarded } from "../_shared/action.js";
import { ownerAsiakasIdFromToken } from "../../owner.js";
import { assertPositiveInt, intFlag, parseId } from "../../targets.js";
// Static: program.ts registers the keikka domain on every invocation anyway, so
// the dynamic import bought nothing and hid the edge from the module graph.
import { runKeikkaValidate } from "../keikka/index.js";
/** GET /api/validation/profiles → ListEnvelope (each row carries `entity`). */
export async function runValidateProfiles(client) {
    const items = await client.get("/api/validation/profiles");
    return listEnvelope(items);
}
/** GET /api/validation/:profile/:asiakasId — company checklist. */
export async function runValidateCompany(client, profile, asiakasId) {
    assertPositiveInt(asiakasId, "--asiakas");
    return client.get(`/api/validation/${encodeURIComponent(profile)}/${asiakasId}`);
}
/** GET /api/validation/person/:profile/:asiakasId/:personId — employee checklist. */
export async function runValidatePerson(client, profile, asiakasId, personId) {
    assertPositiveInt(asiakasId, "--asiakas");
    assertPositiveInt(personId, "--person");
    return client.get(`/api/validation/person/${encodeURIComponent(profile)}/${asiakasId}/${personId}`);
}
/**
 * Register the top-level `ib validate` command as a SINGLE LEAF (no subcommands,
 * so it renders a full leaf `--help` with a FLAGS section). The optional
 * positional `action` is `list` to list profiles, or `person`/`company` paired
 * with a second positional `[id]` as an alias for --person/--asiakas (fb#1407 —
 * every sibling entity command in the CLI takes its target positionally, and
 * this command's own USAGE line advertised the slot without saying what filled
 * it). Both forms may be combined only when they AGREE (fb#1894, mirroring
 * resolveTarget's dual-target convention) — a mismatch exits 4 rather than the
 * positional silently overwriting an explicit flag. Otherwise it runs the
 * flag-driven form unchanged: entity is inferred
 * from `--person`: present → person validation (profile defaults to
 * "onboarding"); absent → company validation (profile required).
 * Profile/entity mismatch is enforced server-side (404). Deploy-gated: 404
 * until /api/validation/person is deployed.
 */
export function registerValidateCommands(parent, getClient) {
    parent
        .command("validate [action] [id]")
        .option("--asiakas <id>", "", Number)
        .option("--person <id>", "", Number)
        .option("--profile <p>")
        .option("--keikka <id>", "", intFlag("--keikka"))
        .action(guarded(async (action, idStr, opts) => {
        const client = await getClient();
        if (opts.keikka != null) {
            writeJson(await runKeikkaValidate(client, { keikkaId: opts.keikka }));
            return;
        }
        if (action === "list") {
            writeJson(await runValidateProfiles(client));
            return;
        }
        if (action === "person" || action === "company") {
            if (idStr === undefined) {
                failWith(`\`validate ${action}\` needs an id: \`ib validate ${action} <id> --profile <p>\`.`, 4);
            }
            const isPerson = action === "person";
            const id = parseId(idStr, isPerson ? "personId" : "asiakasId");
            // fb#1894: the dual-target convention (src/targets.ts resolveTarget) is
            // exactly one required, both allowed only when they AGREE — a caller who
            // passes both got silent last-write-wins instead.
            const flagValue = isPerson ? opts.person : opts.asiakas;
            if (flagValue !== undefined && flagValue !== id) {
                const flagName = isPerson ? "--person" : "--asiakas";
                failWith(`positional ${action} id (${id}) and ${flagName} (${flagValue}) differ — pass only one`, 4);
            }
            if (isPerson)
                opts.person = id;
            else
                opts.asiakas = id;
        }
        else if (action !== undefined) {
            failWith(`Unknown validate action "${action}" — use \`person <id>\`, \`company <id>\`, or \`list\`.`, 4);
        }
        const asiakasId = opts.asiakas ??
            ownerAsiakasIdFromToken(client, "pass --asiakas <id>, or run `ib auth switch`");
        if (opts.person != null) {
            writeJson(await runValidatePerson(client, opts.profile ?? "onboarding", asiakasId, opts.person));
            return;
        }
        if (!opts.profile) {
            failWith("Company validation needs --profile (jerry | betoni). Run `ib validate list` to see profiles.", 4);
        }
        writeJson(await runValidateCompany(client, opts.profile, asiakasId));
    }));
}
//# sourceMappingURL=index.js.map