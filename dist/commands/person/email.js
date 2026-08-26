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
/** POST `path` { personId, personEmail } after resolving the person ref. */
async function postPersonEmail(client, path, person, email, flags) {
    const personId = await resolvePersonRef(client, person);
    return client.post(path, { personId, personEmail: email }, { headers: writeFlagsToHeaders(flags) });
}
/** POST /api/person/addPersonEmail { personId, personEmail }. */
export const runPersonEmailAdd = (client, person, email, flags) => postPersonEmail(client, "/api/person/addPersonEmail", person, email, flags);
/** POST /api/person/setMainPersonEmail { personId, personEmail }. */
export const runPersonEmailSetMain = (client, person, email, flags) => postPersonEmail(client, "/api/person/setMainPersonEmail", person, email, flags);
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
    // The three write leaves share one shape: <person> <email> + write flags.
    for (const [name, run] of [
        ["add", runPersonEmailAdd],
        ["set-main", runPersonEmailSetMain],
        ["remove", runPersonEmailRemove],
    ]) {
        addWriteFlagsToCommand(email.command(`${name} <person> <email>`)).action(guarded(async (personRef, emailAddr, opts) => {
            writeJson(await run(await getClient(), personRef, emailAddr, opts));
        }));
    }
}
//# sourceMappingURL=email.js.map