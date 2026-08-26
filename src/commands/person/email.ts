import type { Command } from "commander";
import type { ApiClient } from "../../api/client.js";
import { listEnvelope, type ListEnvelope } from "../../api/envelopes.js";
import {
  addWriteFlagsToCommand,
  writeFlagsToHeaders,
  type WriteFlags,
} from "../../api/writeFlags.js";
import { writeJson } from "../../output/json.js";
import { resolvePersonRef } from "../notification/index.js";
import { jsonAction, guarded } from "../_shared/action.js";

interface PersonEmailRow {
  email: string;
  main: 0 | 1;
}

/** GET /api/person/getPersonEmails/:personId → ListEnvelope of primary + alternatives. */
export async function runPersonEmailList(
  client: ApiClient,
  person: string
): Promise<ListEnvelope<PersonEmailRow>> {
  const personId = await resolvePersonRef(client, person);
  const rows = await client.get<PersonEmailRow[]>(
    `/api/person/getPersonEmails/${personId}`
  );
  const items = Array.isArray(rows) ? rows : [];
  return listEnvelope(items, { truncated: false });
}

/** POST `path` { personId, personEmail } after resolving the person ref. */
async function postPersonEmail(
  client: ApiClient,
  path: string,
  person: string,
  email: string,
  flags: WriteFlags
): Promise<unknown> {
  const personId = await resolvePersonRef(client, person);
  return client.post(
    path,
    { personId, personEmail: email },
    { headers: writeFlagsToHeaders(flags) }
  );
}

/** POST /api/person/addPersonEmail { personId, personEmail }. */
export const runPersonEmailAdd = (
  client: ApiClient,
  person: string,
  email: string,
  flags: WriteFlags
): Promise<unknown> => postPersonEmail(client, "/api/person/addPersonEmail", person, email, flags);

/** POST /api/person/setMainPersonEmail { personId, personEmail }. */
export const runPersonEmailSetMain = (
  client: ApiClient,
  person: string,
  email: string,
  flags: WriteFlags
): Promise<unknown> =>
  postPersonEmail(client, "/api/person/setMainPersonEmail", person, email, flags);

/** DELETE /api/person/deletePersonEmail/:personId/:email. */
export async function runPersonEmailRemove(
  client: ApiClient,
  person: string,
  email: string,
  flags: WriteFlags
): Promise<unknown> {
  const personId = await resolvePersonRef(client, person);
  return client.delete(
    `/api/person/deletePersonEmail/${personId}/${encodeURIComponent(email)}`,
    { headers: writeFlagsToHeaders(flags) }
  );
}

export function registerPersonEmailCommands(
  person: Command,
  getClient: () => Promise<ApiClient>
): void {
  const email = person
    .command("email")
    .description("Manage a person's alternative email addresses (personEmails)");

  email
    .command("list <person>")
    .action(
      jsonAction(getClient, (client, personRef: string) => runPersonEmailList(client, personRef))
    );

  // The three write leaves share one shape: <person> <email> + write flags.
  for (const [name, run] of [
    ["add", runPersonEmailAdd],
    ["set-main", runPersonEmailSetMain],
    ["remove", runPersonEmailRemove],
  ] as const) {
    addWriteFlagsToCommand(email.command(`${name} <person> <email>`)).action(
      guarded(async (personRef: string, emailAddr: string, opts: WriteFlags) => {
        writeJson(await run(await getClient(), personRef, emailAddr, opts));
      })
    );
  }
}
