import { listEnvelope } from "../../api/envelopes.js";
import { addWriteFlagsToCommand, writeFlagsToHeaders, } from "../../api/writeFlags.js";
import { writeJson } from "../../output/json.js";
import { resolvePersonRef } from "../notification/index.js";
import { jsonAction, guarded } from "../_shared/action.js";
/** GET /api/person/getPersonEmails/:personId → ListEnvelope of primary + alternatives. */
export async function runPersonEmailList(client, person) {
    const personId = await resolvePersonRef(client, person);
    const rows = await client.get(`/api/person/getPersonEmails/${personId}`);
    const items = Array.isArray(rows) ? rows : [];
    return listEnvelope(items, { truncated: false });
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
        .action(jsonAction(getClient, (client, personRef) => runPersonEmailList(client, personRef)));
    const addCmd = email
        .command("add <person> <email>");
    addWriteFlagsToCommand(addCmd).action(guarded(async (personRef, emailAddr, opts) => {
        writeJson(await runPersonEmailAdd(await getClient(), personRef, emailAddr, opts));
    }));
    const setMainCmd = email
        .command("set-main <person> <email>");
    addWriteFlagsToCommand(setMainCmd).action(guarded(async (personRef, emailAddr, opts) => {
        writeJson(await runPersonEmailSetMain(await getClient(), personRef, emailAddr, opts));
    }));
    const removeCmd = email
        .command("remove <person> <email>");
    addWriteFlagsToCommand(removeCmd).action(guarded(async (personRef, emailAddr, opts) => {
        writeJson(await runPersonEmailRemove(await getClient(), personRef, emailAddr, opts));
    }));
}
//# sourceMappingURL=email.js.map