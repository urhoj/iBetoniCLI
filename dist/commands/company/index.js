import { listEnvelope } from "../../api/envelopes.js";
import { runPersistedSwitch } from "../../auth/switch.js";
import { writeJson, exitWithError, failParseUsage } from "../../output/json.js";
import { jsonAction, guarded } from "../_shared/action.js";
import { CliError } from "../../api/errors.js";
import { intFlag, parseId, resolveTarget } from "../../targets.js";
import { decodeJwtPayload } from "../../auth/jwt.js";
import { ownerAsiakasIdFromToken } from "../../owner.js";
import { addWriteFlagsToCommand, writeFlagsToHeaders } from "../../api/writeFlags.js";
function companyName(c) {
    return c.asiakasNimi ?? c.name ?? "";
}
/**
 * Role names per asiakasId from the session JWT — free (the claims are already
 * local, no extra round-trip). Decode failures degrade to "no roles known"
 * rather than failing a read whose network half already succeeded: a token this
 * client just authenticated with is decodable in practice, and a malformed one
 * is `auth doctor`'s problem, not `company list`'s.
 */
function rolesByAsiakasId(client) {
    try {
        const claims = decodeJwtPayload(client.getCurrentToken());
        return new Map(claims.companies.map((c) => [c.asiakasId, c.roles]));
    }
    catch {
        return new Map();
    }
}
/**
 * GET /api/company-selection/available and project to the universal list
 * envelope, annotating each row with `current: boolean` and the `roles` held
 * there (from the JWT — see {@link CompanyListItem.roles}).
 */
export async function runCompanyList(client, opts = {}) {
    const res = await client.get("/api/company-selection/available");
    const roles = rolesByAsiakasId(client);
    // --search is a CLIENT-SIDE substring filter over the caller's own membership
    // set (fb#1766): the route takes no filter, and the set is small enough that
    // narrowing it locally costs nothing — it exists so a caller reaching for
    // `--search` by analogy with every sibling list command gets rows, not exit 4.
    const needle = opts.search?.trim().toLowerCase();
    const items = res.companies
        .map((c) => ({
        asiakasId: c.asiakasId,
        name: companyName(c),
        current: c.asiakasId === res.currentCompanyId,
        roles: roles.get(c.asiakasId) ?? [],
    }))
        .filter((c) => !needle || c.name.toLowerCase().includes(needle));
    return listEnvelope(items);
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
 * Set the ACTIVE company's default depot (asiakas.varikkoSijaintiId) — the "Tyhjänä
 * työmaalle" origin for every vehicle without its own (`ib vehicle update --varikko`),
 * used by the matka recompute and the /oma map (fb#2501). The backend checks the sijainti
 * is a pumppuvarikko/toimipiste and that the caller may edit both tenants.
 *
 * `--dry-run` resolves client-side (echoes the request, never POSTs): the route only
 * honours X-Dry-Run from fb#2501's backend on, and an older backend would persist.
 * `sijaintiId: null` (`--clear`) sends 0, which the backend reads as "clear to NULL" (fb#2540).
 */
export async function runCompanySetVarikko(client, sijaintiId, flags) {
    const asiakasId = ownerAsiakasIdFromToken(client, "run `ib company switch`");
    const body = { asiakasId, sijaintiId: sijaintiId ?? 0 };
    if (flags.dryRun)
        return { dryRun: true, wouldUpdate: { asiakasId, varikkoSijaintiId: sijaintiId } };
    await client.post("/api/asiakas/sijainti/varikko/saveDefaultSijainti", body, {
        headers: writeFlagsToHeaders(flags),
    });
    return { ok: true, asiakasId, varikkoSijaintiId: sijaintiId };
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
        .option("--search <substr>", "Case-insensitive substring filter on the company name (client-side)")
        .action(jsonAction(getClient, runCompanyList));
    company
        .command("current")
        .action(jsonAction(getClient, runCompanyCurrent));
    company
        // Dual-target (fb#1751), mirrors `ib auth switch`.
        .command("switch [asiakasId]")
        .option("--to <asiakasId>", "Target asiakasId (alias for the positional)", intFlag("--to"))
        .action(guarded(async (idStr, opts) => {
        writeJson(await runPersistedSwitch(resolveTarget(idStr, opts.to, "asiakasId", "to"), isReadOnly()));
    }));
    addWriteFlagsToCommand(company
        .command("set-varikko [sijaintiId]")
        .option("--clear", "Clear the default depot (asiakas.varikkoSijaintiId → NULL)")).action(guarded(async (idStr, opts) => {
        if ((idStr === undefined) === !opts.clear)
            failParseUsage("pass exactly one of <sijaintiId> or --clear");
        const sijaintiId = opts.clear ? null : parseId(idStr, "sijaintiId");
        writeJson(await runCompanySetVarikko(await getClient(), sijaintiId, opts));
    }));
    // `ib company validate` was renamed to the top-level `ib validate` (clean
    // break, mirrors the ib changes→ib log rename). Old path errors with exit 4.
    company
        .command("validate", { hidden: true })
        .allowUnknownOption(true)
        .argument("[args...]")
        .action(() => {
        exitWithError(new CliError("'ib company validate' was renamed. Use: ib validate --asiakas <id> --profile <p> (company) or ib validate --asiakas <id> --person <id> (employee).", 0, null, 4));
    });
    // NOTE: `ib company modules|settings` used to be registered signpost commands
    // (feedback #353). They were retired in favour of the general sibling-group
    // resolver (GROUP_SIBLING_DOMAINS company↔customer in unknownCommand.ts): as
    // registered commands they SHADOWED it, answering with a plainer error than
    // the machine-readable envelope the unknown-subcommand path now builds.
}
//# sourceMappingURL=index.js.map