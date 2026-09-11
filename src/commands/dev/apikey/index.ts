/**
 * `ib dev apikey` — sysadmin credential admin for dbo.apiKeys (fb#1563).
 *
 * Before this, adding/rotating/revoking any integration credential (Ecofleet,
 * Fennoa, Mapon, SendGrid, Netvisor, ...) required a developer to hand-write a
 * prod SQL INSERT — there was no write path anywhere in the product. `set`/
 * `verify`/`list`/`revoke` here are that path.
 *
 * INVARIANT: the credential value never appears in ANY response from this
 * group, under any code path — not on create, not on a dry run. The backend
 * enforces this (never selects/echoes the column) and its controller test
 * asserts the absence. The CLI-side "leaky mock" tests strip nothing: they
 * document that a leaked backend value would pass through untouched, i.e.
 * where such a backend regression would become visible (fb#1593).
 *
 * Gating is split by verb, deliberately stricter than the rest of `ib dev`:
 * `set`/`revoke` require isSystemAdmin ONLY ("isAnyAdmin is NOT enough" per
 * the ticket); `verify`/`list`/`sources` use the usual isSystemAdminOrDeveloper
 * gate every other `ib dev` read command uses, since they never reveal the
 * secret. See CommandSpec `permissions` in dev-meta.ts for the exact wording.
 */
import { readFileSync } from "node:fs";
import type { Command } from "commander";
import type { ApiClient } from "../../../api/client.js";
import { listEnvelope, type ListEnvelope } from "../../../api/envelopes.js";
import { qs } from "../../../api/query.js";
import { failWith } from "../../../output/json.js";
import { intFlag } from "../../../targets.js";
import { resolveDate } from "../../../dates.js";
import { addWriteFlagsToCommand, writeFlagsToHeaders, type WriteFlags } from "../../../api/writeFlags.js";
import { jsonAction } from "../../_shared/action.js";

export interface ApiKeyEntry {
  apiKeySourceId: number;
  apiKeySourceName: string;
  apiKeyName: string;
  entryTime: string;
  apiKeyActive: boolean;
  expires: string | null;
  valueLength: number;
  apiKeyDescription: string | null;
}

export interface ApiKeySourceEntry {
  apiKeySourceId: number;
  apiKeySourceName: string;
  apiKeySourceDescription: string | null;
}

/** GET /api/cli/apikeys/sources — the reference list, so a caller can find a valid apiKeySourceId before calling `set`. */
export async function runApikeySources(client: ApiClient): Promise<ListEnvelope<ApiKeySourceEntry>> {
  const res = await client.get<{ items: ApiKeySourceEntry[] }>("/api/cli/apikeys/sources");
  return listEnvelope(res.items);
}

/** GET /api/cli/apikeys/list — every key configured for a tenant, across all sources. */
export async function runApikeyList(client: ApiClient, ownerAsiakasId: number): Promise<ListEnvelope<ApiKeyEntry>> {
  const res = await client.get<{ items: ApiKeyEntry[] }>(`/api/cli/apikeys/list${qs({ ownerAsiakasId })}`);
  return listEnvelope(res.items);
}

export interface ApikeyVerifyInput {
  asiakas?: number;
  source?: number;
  name?: string;
}

/** GET /api/cli/apikeys/verify — one named key, or every key under a source when --name is omitted. */
export async function runApikeyVerify(
  client: ApiClient,
  input: ApikeyVerifyInput
): Promise<{ found: boolean; entries: ApiKeyEntry[] }> {
  if (!input.asiakas) failWith("--asiakas is required", 4);
  if (!input.source) failWith("--source is required", 4);
  return client.get(
    `/api/cli/apikeys/verify${qs({ ownerAsiakasId: input.asiakas, apiKeySourceId: input.source, apiKeyName: input.name })}`
  );
}

export interface ApikeySetInput {
  asiakas?: number;
  source?: number;
  name?: string;
  value?: string;
  valueStdin?: boolean;
  description?: string;
  expires?: string;
}

/** Reads stdin synchronously, trimmed — a trailing newline from a shell pipe or heredoc is not part of the secret. */
function readValueFromStdin(): string {
  try {
    return readFileSync(0, "utf8").trim();
  } catch {
    return failWith("--value-stdin: could not read a value from stdin", 4);
  }
}

/**
 * POST /api/cli/apikeys/set — create or replace by (asiakas, source, name).
 * Replacing an existing key always reactivates it (apiKeyActive=1) — the
 * backend's semantics, documented here so the CLI help states it too.
 */
export async function runApikeySet(
  client: ApiClient,
  input: ApikeySetInput,
  flags: WriteFlags
): Promise<Record<string, unknown>> {
  if (!input.asiakas) failWith("--asiakas is required", 4);
  if (!input.source) failWith("--source is required", 4);
  if (!input.name?.trim()) failWith("--name is required", 4);
  if (input.value && input.valueStdin) failWith("--value and --value-stdin are mutually exclusive", 4);
  const value = input.valueStdin ? readValueFromStdin() : input.value;
  if (!value) {
    failWith(
      "Provide the credential via --value <text> or --value-stdin (stdin avoids the value landing in shell history)",
      4
    );
  }

  const body: Record<string, unknown> = {
    ownerAsiakasId: input.asiakas,
    apiKeySourceId: input.source,
    apiKeyName: input.name.trim(),
    apiKeyValue: value,
  };
  if (input.description) body.apiKeyDescription = input.description;
  if (input.expires) body.expires = resolveDate(input.expires);

  return client.post<Record<string, unknown>>("/api/cli/apikeys/set", body, {
    headers: writeFlagsToHeaders(flags),
  });
}

export interface ApikeyRevokeInput {
  asiakas?: number;
  source?: number;
  name?: string;
}

/** DELETE /api/cli/apikeys/revoke — soft revoke (apiKeyActive=0); idempotent. */
export async function runApikeyRevoke(
  client: ApiClient,
  input: ApikeyRevokeInput,
  flags: WriteFlags
): Promise<Record<string, unknown>> {
  if (!input.asiakas) failWith("--asiakas is required", 4);
  if (!input.source) failWith("--source is required", 4);
  if (!input.name?.trim()) failWith("--name is required", 4);

  return client.delete<Record<string, unknown>>(
    `/api/cli/apikeys/revoke${qs({
      ownerAsiakasId: input.asiakas,
      apiKeySourceId: input.source,
      apiKeyName: input.name.trim(),
    })}`,
    { headers: writeFlagsToHeaders(flags) }
  );
}

export function registerApikeyCommands(parent: Command, getClient: () => Promise<ApiClient>): void {
  const cmd = parent
    .command("apikey")
    .description(
      "Sysadmin credential admin for dbo.apiKeys (Ecofleet/Fennoa/Mapon/SendGrid/Netvisor/...) — create/replace, revoke, verify, list. The credential value never appears in any response."
    );

  cmd.command("sources").action(jsonAction(getClient, (client) => runApikeySources(client)));

  cmd
    .command("list")
    .option("--asiakas <id>", "Target tenant ownerAsiakasId", intFlag("--asiakas"))
    .action(
      jsonAction(getClient, (client, opts: { asiakas?: number }) => {
        if (!opts.asiakas) failWith("--asiakas is required", 4);
        return runApikeyList(client, opts.asiakas as number);
      })
    );

  cmd
    .command("verify")
    .option("--asiakas <id>", "Target tenant ownerAsiakasId", intFlag("--asiakas"))
    .option("--source <id>", "apiKeySourceId (see `ib dev apikey sources`)", intFlag("--source"))
    .option("--name <name>", "apiKeyName — omit to see every key configured for that source")
    .action(
      jsonAction(getClient, (client, opts: ApikeyVerifyInput) => runApikeyVerify(client, opts))
    );

  addWriteFlagsToCommand(
    cmd
      .command("set")
      .option("--asiakas <id>", "Target tenant ownerAsiakasId", intFlag("--asiakas"))
      .option("--source <id>", "apiKeySourceId (see `ib dev apikey sources`)", intFlag("--source"))
      .option("--name <name>", "apiKeyName, e.g. MAPON_APIKEY")
      .option("--value <text>", "The credential value (prefer --value-stdin on a shared shell)")
      .option("--value-stdin", "Read the credential value from stdin instead of argv")
      .option("--description <text>", "Optional human-readable note")
      .option("--expires <date>", "Optional expiry date (today|yesterday|tomorrow or YYYY-MM-DD)")
  ).action(
    jsonAction(getClient, (client, opts: ApikeySetInput & WriteFlags) => runApikeySet(client, opts, opts))
  );

  addWriteFlagsToCommand(
    cmd
      .command("revoke")
      .option("--asiakas <id>", "Target tenant ownerAsiakasId", intFlag("--asiakas"))
      .option("--source <id>", "apiKeySourceId (see `ib dev apikey sources`)", intFlag("--source"))
      .option("--name <name>", "apiKeyName to revoke")
  ).action(
    jsonAction(getClient, (client, opts: ApikeyRevokeInput & WriteFlags) => runApikeyRevoke(client, opts, opts))
  );
}
