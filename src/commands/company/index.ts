import type { Command } from "commander";
import type { ApiClient } from "../../api/client.js";
import { listEnvelope, type ListEnvelope } from "../../api/envelopes.js";
import { runPersistedSwitch } from "../../auth/switch.js";
import { writeJson, exitWithError } from "../../output/json.js";
import { jsonAction, guarded } from "../_shared/action.js";
import { CliError } from "../../api/errors.js";
import { intFlag } from "../../targets.js";
import { decodeJwtPayload } from "../../auth/jwt.js";

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
  /**
   * Role names held in THIS company, read from the session JWT's
   * `asiakasesWithTypes`. `[]` = membership with no roles (a real state — see
   * asiakasId 4) or a company the token predates. Merged in here because
   * neither output answered "which companies can I act on, as what" alone:
   * `auth whoami` had the roles but no names, this had the names but no roles
   * (fb#380). The names cannot go the other way — the JWT carries a name only
   * for the ACTIVE company, so `renderWhoami` would need a network call and it
   * is deliberately pure.
   */
  roles: string[];
}

export interface CompanyCurrent {
  asiakasId: number;
  name: string;
}

/**
 * Role names per asiakasId from the session JWT — free (the claims are already
 * local, no extra round-trip). Decode failures degrade to "no roles known"
 * rather than failing a read whose network half already succeeded: a token this
 * client just authenticated with is decodable in practice, and a malformed one
 * is `auth doctor`'s problem, not `company list`'s.
 */
function rolesByAsiakasId(client: ApiClient): Map<number, string[]> {
  try {
    const claims = decodeJwtPayload(client.getCurrentToken());
    return new Map(claims.companies.map((c) => [c.asiakasId, c.roles]));
  } catch {
    return new Map();
  }
}

/**
 * GET /api/company-selection/available and project to the universal list
 * envelope, annotating each row with `current: boolean` and the `roles` held
 * there (from the JWT — see {@link CompanyListItem.roles}).
 */
export async function runCompanyList(
  client: ApiClient
): Promise<ListEnvelope<CompanyListItem>> {
  const res = await client.get<AvailableResponse>(
    "/api/company-selection/available"
  );
  const roles = rolesByAsiakasId(client);
  const items = res.companies.map((c) => ({
    asiakasId: c.asiakasId,
    name: companyName(c),
    current: c.asiakasId === res.currentCompanyId,
    roles: roles.get(c.asiakasId) ?? [],
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
    .requiredOption("--to <asiakasId>", "", intFlag("--to"))
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

  // NOTE: `ib company modules|settings` used to be registered signpost commands
  // (feedback #353). They were retired in favour of the general sibling-group
  // resolver (GROUP_SIBLING_DOMAINS company↔customer in unknownCommand.ts): as
  // registered commands they SHADOWED it, answering with a plainer error than
  // the machine-readable envelope the unknown-subcommand path now builds.
}
