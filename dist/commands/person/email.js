import { addWriteFlagsToCommand, writeFlagsToHeaders, } from "../../api/writeFlags.js";
import { writeJson, failWith, exitWithError } from "../../output/json.js";
import { resolvePersonRef } from "../notification/index.js";
/** GET /api/person/getPersonEmails/:personId → ListEnvelope of primary + alternatives. */
export async function runPersonEmailList(client, person) {
    const personId = await resolvePersonRef(client, person);
    const rows = await client.get(`/api/person/getPersonEmails/${personId}`);
    const items = Array.isArray(rows) ? rows : [];
    return { items, nextCursor: null, count: items.length, truncated: false };
}
/** POST /api/person/addPersonEmail { personId, personEmail }. */
export async function runPersonEmailAdd(client, person, email, flags) {
    const personId = await resolvePersonRef(client, person);
    return client.post("/api/person/addPersonEmail", { personId, personEmail: email }, { headers: writeFlagsToHeaders(flags) });
}
/** DELETE /api/person/deletePersonEmail/:personId/:email. */
export async function runPersonEmailRemove(client, person, email, flags) {
    const personId = await resolvePersonRef(client, person);
    return client.delete(`/api/person/deletePersonEmail/${personId}/${encodeURIComponent(email)}`, { headers: writeFlagsToHeaders(flags) });
}
export function registerPersonEmailCommands(person, getClient) {
    const email = person
        .command("email")
        .description("Manage a person's alternative email addresses (personEmails)");
    email
        .command("list <person>")
        .description("List a person's emails — primary (main:1) and alternatives (main:0)")
        .action(async (personRef) => {
        try {
            writeJson(await runPersonEmailList(await getClient(), personRef));
        }
        catch (e) {
            exitWithError(e);
        }
    });
    const addCmd = email
        .command("add <person> <email>")
        .description("Add an alternative email to a person. Requires --reason.");
    addWriteFlagsToCommand(addCmd).action(async (personRef, emailAddr, opts) => {
        if (!opts.reason)
            failWith("Missing required flag: --reason", 4);
        try {
            writeJson(await runPersonEmailAdd(await getClient(), personRef, emailAddr, {
                dryRun: opts.dryRun,
                idempotencyKey: opts.idempotencyKey,
                reason: opts.reason,
            }));
        }
        catch (e) {
            exitWithError(e);
        }
    });
    const removeCmd = email
        .command("remove <person> <email>")
        .description("Remove an alternative email from a person. Requires --reason.");
    addWriteFlagsToCommand(removeCmd).action(async (personRef, emailAddr, opts) => {
        if (!opts.reason)
            failWith("Missing required flag: --reason", 4);
        try {
            writeJson(await runPersonEmailRemove(await getClient(), personRef, emailAddr, {
                dryRun: opts.dryRun,
                idempotencyKey: opts.idempotencyKey,
                reason: opts.reason,
            }));
        }
        catch (e) {
            exitWithError(e);
        }
    });
}
//# sourceMappingURL=email.js.map