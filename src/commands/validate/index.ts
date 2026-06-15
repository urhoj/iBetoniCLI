import type { Command } from "commander";
import type { ApiClient } from "../../api/client.js";
import type { ListEnvelope } from "../../api/envelopes.js";
import { writeJson, exitWithError } from "../../output/json.js";
import { decodeJwtPayload } from "../../auth/jwt.js";
import { CliError } from "../../api/errors.js";

export interface ValidationProfileRow {
  id: string;
  titleFi: string;
  description: string | null;
  entity: "company" | "person";
}

/** GET /api/validation/profiles → ListEnvelope (each row carries `entity`). */
export async function runValidateProfiles(
  client: ApiClient
): Promise<ListEnvelope<ValidationProfileRow>> {
  const items = await client.get<ValidationProfileRow[]>("/api/validation/profiles");
  return { items, nextCursor: null, count: items.length };
}

/** GET /api/validation/:profile/:asiakasId — company checklist. */
export async function runValidateCompany(
  client: ApiClient,
  profile: string,
  asiakasId: number
): Promise<unknown> {
  if (!Number.isInteger(asiakasId) || asiakasId < 1) {
    throw new CliError("--asiakas must be a positive integer", 0, null, 4);
  }
  return client.get<unknown>(`/api/validation/${encodeURIComponent(profile)}/${asiakasId}`);
}

/** GET /api/validation/person/:profile/:asiakasId/:personId — employee checklist. */
export async function runValidatePerson(
  client: ApiClient,
  profile: string,
  asiakasId: number,
  personId: number
): Promise<unknown> {
  if (!Number.isInteger(asiakasId) || asiakasId < 1) {
    throw new CliError("--asiakas must be a positive integer", 0, null, 4);
  }
  if (!Number.isInteger(personId) || personId < 1) {
    throw new CliError("--person must be a positive integer", 0, null, 4);
  }
  return client.get<unknown>(
    `/api/validation/person/${encodeURIComponent(profile)}/${asiakasId}/${personId}`
  );
}

/**
 * Register the top-level `ib validate` command. Entity is inferred from
 * `--person`: present → person validation (profile defaults to "onboarding");
 * absent → company validation (profile required). `ib validate list` lists
 * profiles (each row carries `entity`). Profile/entity mismatch is enforced
 * server-side (404). Deploy-gated: 404 until /api/validation/person is deployed.
 */
export function registerValidateCommands(
  parent: Command,
  getClient: () => Promise<ApiClient>
): void {
  const validate = parent
    .command("validate")
    .description(
      "Validate a company or a single employee against a profile (company: jerry|betoni; person: onboarding)"
    )
    .option("--asiakas <id>", "Target asiakasId (default: active company)", Number)
    .option("--person <id>", "Validate this person as an employee of the company", Number)
    .option("--profile <p>", "Profile id (company: jerry|betoni; person: onboarding [default])")
    .action(
      async (opts: { asiakas?: number; person?: number; profile?: string }) => {
        try {
          const client = await getClient();
          const asiakasId =
            opts.asiakas ?? decodeJwtPayload(client.getCurrentToken()).ownerAsiakasId;
          if (opts.person != null) {
            const profile = opts.profile ?? "onboarding";
            writeJson(await runValidatePerson(client, profile, asiakasId, opts.person));
            return;
          }
          if (!opts.profile) {
            throw new CliError(
              "Company validation needs --profile (jerry | betoni). Run `ib validate list` to see profiles.",
              0,
              null,
              4
            );
          }
          writeJson(await runValidateCompany(client, opts.profile, asiakasId));
        } catch (e) {
          exitWithError(e);
        }
      }
    );

  validate
    .command("list")
    .description("List available validation profiles (each row carries its entity)")
    .action(async () => {
      try {
        writeJson(await runValidateProfiles(await getClient()));
      } catch (e) {
        exitWithError(e);
      }
    });
}
