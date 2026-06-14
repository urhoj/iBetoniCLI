import { createStore, defaultCredentialsPath } from "../../auth/store.js";
import { performSwitch, assertPersistedSwitchAllowed, } from "../../auth/switch.js";
import { writeJson, exitWithError, failWith } from "../../output/json.js";
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
function companyName(c) {
    return c.asiakasNimi ?? c.name ?? "";
}
/**
 * GET /api/company-selection/available and project to the universal list
 * envelope, annotating each row with `current: boolean`.
 */
export async function runCompanyList(client) {
    const res = await client.get("/api/company-selection/available");
    const items = res.companies.map((c) => ({
        asiakasId: c.asiakasId,
        name: companyName(c),
        current: c.asiakasId === res.currentCompanyId,
    }));
    return { items, nextCursor: null, count: items.length };
}
/**
 * GET /api/company-selection/available and return only the active company
 * record. Throws if the response has no matching entry.
 */
export async function runCompanyCurrent(client) {
    const res = await client.get("/api/company-selection/available");
    const current = res.companies.find((c) => c.asiakasId === res.currentCompanyId);
    if (!current)
        throw new Error("No current company in response");
    return { asiakasId: current.asiakasId, name: companyName(current) };
}
/**
 * Register `ib company` subcommands on the parent commander instance:
 *   - list     enumerate available companies with `current` flag
 *   - current  print the active company
 *   - switch   change active company and persist the rotated JWT
 *
 * Exit codes: 2 = not logged in; 1 = generic API/runtime failure.
 *
 * `isReadOnly` resolves the session write-lock at action time: `company switch`
 * persists a rotated JWT, so it is refused (exit 3) under read-only mode.
 */
export function registerCompanyCommands(parent, getClient, isReadOnly) {
    const company = parent.command("company").description("Company commands");
    company
        .command("list")
        .description("List available companies for the current user")
        .action(async () => {
        try {
            const client = await getClient();
            const result = await runCompanyList(client);
            writeJson(result);
        }
        catch (e) {
            exitWithError(e);
        }
    });
    company
        .command("current")
        .description("Print the active company")
        .action(async () => {
        try {
            const client = await getClient();
            const result = await runCompanyCurrent(client);
            writeJson(result);
        }
        catch (e) {
            exitWithError(e);
        }
    });
    company
        .command("switch")
        .description("Switch the active company and persist the rotated JWT")
        .requiredOption("--to <asiakasId>", "Target asiakasId", (v) => Number(v))
        .action(async (opts) => {
        try {
            assertPersistedSwitchAllowed(isReadOnly());
            const store = createStore(defaultCredentialsPath());
            const creds = await store.load();
            if (!creds) {
                failWith("Not logged in. Run `ib auth login` first.", 2);
            }
            const next = await performSwitch({
                endpoint: creds.endpoint,
                jwt: creds.jwt,
                toAsiakasId: opts.to,
            });
            await store.save({
                ...creds,
                jwt: next.jwt,
                ownerAsiakasId: next.ownerAsiakasId,
                ownerAsiakasName: next.ownerAsiakasName,
            });
            writeJson({
                ok: true,
                activeCompany: {
                    asiakasId: next.ownerAsiakasId,
                    name: next.ownerAsiakasName,
                },
            });
        }
        catch (e) {
            exitWithError(e);
        }
    });
    // `validate` runs a per-company setup checklist (jerry / betoni profiles), so
    // it lives with the other company commands. Bare `validate` (or the reserved
    // word `list`) lists profiles; a profile id runs the server-side checklist.
    // The profile string is passed through, so new server-side profiles need zero
    // CLI changes. Deploy-gated: 404 until /api/validation is deployed.
    company
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