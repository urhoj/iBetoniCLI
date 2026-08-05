import type { Command } from "commander";
import type { ApiClient } from "../../api/client.js";
import { listEnvelope, type ListEnvelope } from "../../api/envelopes.js";
import {
  addWriteFlagsToCommand,
  writeFlagsToHeaders,
  type WriteFlags,
  requireReason,
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

/** POST /api/person/addPersonEmail { personId, personEmail }. */
export async function runPersonEmailAdd(
  client: ApiClient,
  person: string,
  email: string,
  flags: WriteFlags
): Promise<unknown> {
  const personId = await resolvePersonRef(client, person);
  return client.post(
    "/api/person/addPersonEmail",
    { personId, personEmail: email },
    { headers: writeFlagsToHeaders(flags) }
  );
}

/** POST /api/person/setMainPersonEmail { personId, personEmail }. */
export async function runPersonEmailSetMain(
  client: ApiClient,
  person: string,
  email: string,
  flags: WriteFlags
): Promise<unknown> {
  const personId = await resolvePersonRef(client, person);
  return client.post(
    "/api/person/setMainPersonEmail",
    { personId, personEmail: email },
    { headers: writeFlagsToHeaders(flags) }
  );
}

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

  const addCmd = email
    .command("add <person> <email>");
  addWriteFlagsToCommand(addCmd).action(
    guarded(async (personRef: string, emailAddr: string, opts: WriteFlags) => {
      requireReason(opts);
      writeJson(
        await runPersonEmailAdd(await getClient(), personRef, emailAddr, opts)
      );
    })
  );

  const setMainCmd = email
    .command("set-main <person> <email>");
  addWriteFlagsToCommand(setMainCmd).action(
    guarded(async (personRef: string, emailAddr: string, opts: WriteFlags) => {
      requireReason(opts);
      writeJson(
        await runPersonEmailSetMain(await getClient(), personRef, emailAddr, opts)
      );
    })
  );

  const removeCmd = email
    .command("remove <person> <email>");
  addWriteFlagsToCommand(removeCmd).action(
    guarded(async (personRef: string, emailAddr: string, opts: WriteFlags) => {
      requireReason(opts);
      writeJson(
        await runPersonEmailRemove(await getClient(), personRef, emailAddr, opts)
      );
    })
  );
}
