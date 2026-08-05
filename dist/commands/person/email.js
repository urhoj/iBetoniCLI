import { addWriteFlagsToCommand, writeFlagsToHeaders, } from "../../api/writeFlags.js";
import { writeJson, failWith } from "../../output/json.js";
import { resolvePersonRef } from "../notification/index.js";
import { guarded } from "../_shared/action.js";
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
/** POST /api/person/setMainPersonEmail { personId, personEmail }. */
export async function runPersonEmailSetMain(client, person, email, flags) {
    const personId = await resolvePersonRef(client, person);
    return client.post("/api/person/setMainPersonEmail", { personId, personEmail: email }, { headers: writeFlagsToHeaders(flags) });
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
        .action(guarded(async (personRef) => {
        writeJson(await runPersonEmailList(await getClient(), personRef));
    }));
    const addCmd = email
        .command("add <person> <email>");
    addWriteFlagsToCommand(addCmd).action(guarded(async (personRef, emailAddr, opts) => {
        if (!opts.reason)
            failWith("Missing required flag: --reason", 4);
        writeJson(await runPersonEmailAdd(await getClient(), personRef, emailAddr, {
            dryRun: opts.dryRun,
            idempotencyKey: opts.idempotencyKey,
            reason: opts.reason,
        }));
    }));
    const setMainCmd = email
        .command("set-main <person> <email>");
    addWriteFlagsToCommand(setMainCmd).action(guarded(async (personRef, emailAddr, opts) => {
        if (!opts.reason)
            failWith("Missing required flag: --reason", 4);
        writeJson(await runPersonEmailSetMain(await getClient(), personRef, emailAddr, {
            dryRun: opts.dryRun,
            idempotencyKey: opts.idempotencyKey,
            reason: opts.reason,
        }));
    }));
    const removeCmd = email
        .command("remove <person> <email>");
    addWriteFlagsToCommand(removeCmd).action(guarded(async (personRef, emailAddr, opts) => {
        if (!opts.reason)
            failWith("Missing required flag: --reason", 4);
        writeJson(await runPersonEmailRemove(await getClient(), personRef, emailAddr, {
            dryRun: opts.dryRun,
            idempotencyKey: opts.idempotencyKey,
            reason: opts.reason,
        }));
    }));
}
//# sourceMappingURL=email.js.map