import type { Command } from "commander";
import type { ApiClient } from "../../api/client.js";
import { listEnvelope, type ListEnvelope } from "../../api/envelopes.js";
import { runPersistedSwitch } from "../../auth/switch.js";
import { writeJson, exitWithError } from "../../output/json.js";
import { jsonAction, guarded } from "../_shared/action.js";
import { CliError } from "../../api/errors.js";

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
  return listEnvelope(items);
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
    .action(jsonAction(getClient, runCompanyList));

  company
    .command("current")
    .action(jsonAction(getClient, runCompanyCurrent));

  company
    .command("switch")
    .requiredOption("--to <asiakasId>", "Target asiakasId", (v: string) =>
      Number(v)
    )
    .action(
      guarded(async (opts: { to: number }) => {
        writeJson(await runPersistedSwitch(opts.to, isReadOnly()));
      })
    );

  // `ib company validate` was renamed to the top-level `ib validate` (clean
  // break, mirrors the ib changes→ib log rename). Old path errors with exit 4.
  company
    .command("validate", { hidden: true })
    .allowUnknownOption(true)
    .argument("[args...]")
    .action(() => {
      exitWithError(
        new CliError(
          "'ib company validate' was renamed. Use: ib validate --asiakas <id> --profile <p> (company) or ib validate --asiakas <id> --person <id> (employee).",
          0,
          null,
          4
        )
      );
    });
}
