import type { Command } from "commander";
import type { ApiClient } from "../../api/client.js";
import { listEnvelope, type ListEnvelope } from "../../api/envelopes.js";
import { writeJson, failWith } from "../../output/json.js";
import { guarded } from "../_shared/action.js";
import { ownerAsiakasIdFromToken } from "../../owner.js";
import { assertPositiveInt } from "../../targets.js";
// Static: program.ts registers the keikka domain on every invocation anyway, so
// the dynamic import bought nothing and hid the edge from the module graph.
import { runKeikkaValidate } from "../keikka/index.js";

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
  return listEnvelope(items);
}

/** GET /api/validation/:profile/:asiakasId — company checklist. */
export async function runValidateCompany(
  client: ApiClient,
  profile: string,
  asiakasId: number
): Promise<unknown> {
  assertPositiveInt(asiakasId, "--asiakas");
  return client.get<unknown>(`/api/validation/${encodeURIComponent(profile)}/${asiakasId}`);
}

/** GET /api/validation/person/:profile/:asiakasId/:personId — employee checklist. */
export async function runValidatePerson(
  client: ApiClient,
  profile: string,
  asiakasId: number,
  personId: number
): Promise<unknown> {
  assertPositiveInt(asiakasId, "--asiakas");
  assertPositiveInt(personId, "--person");
  return client.get<unknown>(
    `/api/validation/person/${encodeURIComponent(profile)}/${asiakasId}/${personId}`
  );
}

/**
 * Register the top-level `ib validate` command as a SINGLE LEAF (no subcommands,
 * so it renders a full leaf `--help` with a FLAGS section). The optional
 * positional `action` is `list` to list profiles; otherwise it runs flag-driven
 * validation. Entity is inferred from `--person`: present → person validation
 * (profile defaults to "onboarding"); absent → company validation (profile
 * required). Profile/entity mismatch is enforced server-side (404). Deploy-gated:
 * 404 until /api/validation/person is deployed.
 */
export function registerValidateCommands(
  parent: Command,
  getClient: () => Promise<ApiClient>
): void {
  parent
    .command("validate [action]")
    .option("--asiakas <id>", "Target asiakasId (default: active company)", Number)
    .option("--person <id>", "Validate this person as an employee of the company", Number)
    .option("--profile <p>", "Profile id (company: jerry|betoni; person: onboarding [default])")
    .option("--keikka <id>", "Validate this keikka against the reminders-drawer rules (alias of ib keikka validate <id>)", Number)
    .action(
      guarded(async (action: string | undefined, opts: { asiakas?: number; person?: number; profile?: string; keikka?: number }) => {
        const client = await getClient();
        if (opts.keikka != null) {
          writeJson(await runKeikkaValidate(client, { keikkaId: opts.keikka }));
          return;
        }
        if (action === "list") {
          writeJson(await runValidateProfiles(client));
          return;
        }
        const asiakasId =
          opts.asiakas ??
          ownerAsiakasIdFromToken(client, "pass --asiakas <id>, or run `ib auth switch`");
        if (opts.person != null) {
          writeJson(
            await runValidatePerson(client, opts.profile ?? "onboarding", asiakasId, opts.person)
          );
          return;
        }
        if (!opts.profile) {
          failWith(
            "Company validation needs --profile (jerry | betoni). Run `ib validate list` to see profiles.",
            4
          );
        }
        writeJson(await runValidateCompany(client, opts.profile, asiakasId));
      })
    );
}
