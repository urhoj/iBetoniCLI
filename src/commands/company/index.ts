import type { Command } from "commander";
import type { ApiClient } from "../../api/client.js";
import type { ListEnvelope } from "../../api/envelopes.js";
import { createStore, defaultCredentialsPath } from "../../auth/store.js";
import {
  performSwitch,
  assertPersistedSwitchAllowed,
} from "../../auth/switch.js";
import { writeJson, writeError, exitWithError } from "../../output/json.js";

interface AvailableCompany {
  asiakasId: number;
  // Backend returns Finnish `asiakasNimi`; older callers may have used `name`.
  asiakasNimi?: string;
  name?: string;
}

interface AvailableResponse {
  companies: AvailableCompany[];
  currentCompanyId: number;
}

function companyName(c: AvailableCompany): string {
  return c.asiakasNimi ?? c.name ?? "";
}

export interface CompanyListItem {
  asiakasId: number;
  name: string;
  current: boolean;
}

export interface CompanyCurrent {
  asiakasId: number;
  name: string;
}

/**
 * GET /api/company-selection/available and project to the universal list
 * envelope, annotating each row with `current: boolean`.
 */
export async function runCompanyList(
  client: ApiClient
): Promise<ListEnvelope<CompanyListItem>> {
  const res = await client.get<AvailableResponse>(
    "/api/company-selection/available"
  );
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
export async function runCompanyCurrent(
  client: ApiClient
): Promise<CompanyCurrent> {
  const res = await client.get<AvailableResponse>(
    "/api/company-selection/available"
  );
  const current = res.companies.find(
    (c) => c.asiakasId === res.currentCompanyId
  );
  if (!current) throw new Error("No current company in response");
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
export function registerCompanyCommands(
  parent: Command,
  getClient: () => Promise<ApiClient>,
  isReadOnly: () => boolean
): void {
  const company = parent.command("company").description("Company commands");

  company
    .command("list")
    .description("List available companies for the current user")
    .action(async () => {
      try {
        const client = await getClient();
        const result = await runCompanyList(client);
        writeJson(result);
      } catch (e) {
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
      } catch (e) {
        exitWithError(e);
      }
    });

  company
    .command("switch")
    .description("Switch the active company and persist the rotated JWT")
    .requiredOption("--to <asiakasId>", "Target asiakasId", (v: string) =>
      Number(v)
    )
    .action(async (opts: { to: number }) => {
      try {
        assertPersistedSwitchAllowed(isReadOnly());
        const store = createStore(defaultCredentialsPath());
        const creds = await store.load();
        if (!creds) {
          writeError(new Error("Not logged in. Run `ib auth login` first."));
          process.exit(2);
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
      } catch (e) {
        exitWithError(e);
      }
    });
}
