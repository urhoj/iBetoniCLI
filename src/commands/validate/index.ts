import type { Command } from "commander";
import type { ApiClient } from "../../api/client.js";
import { writeJson, exitWithError } from "../../output/json.js";
import { decodeJwtPayload } from "../../auth/jwt.js";
import { CliError } from "../../api/errors.js";

export interface ValidationProfileRow {
  id: string;
  titleFi: string;
  description: string | null;
}

/** GET /api/validation/profiles → ListEnvelope. */
export async function runValidateProfiles(client: ApiClient): Promise<unknown> {
  const items = await client.get<ValidationProfileRow[]>("/api/validation/profiles");
  return { items, nextCursor: null, count: items.length };
}

/** GET /api/validation/:profile/:asiakasId — server-evaluated checklist. */
export async function runValidate(
  client: ApiClient,
  profile: string,
  asiakasId: number
): Promise<unknown> {
  if (!Number.isInteger(asiakasId) || asiakasId < 1) {
    throw new CliError("--asiakas must be a positive integer", 0, null, 4);
  }
  return client.get<unknown>(`/api/validation/${encodeURIComponent(profile)}/${asiakasId}`);
}

/**
 * Register `ib validate [profile]` — company-setup validation profiles.
 * Bare `ib validate` (or the reserved word `list`) lists profiles; with a
 * profile id it runs the server-side checklist. The profile string is passed
 * through, so future server-side profiles need zero CLI changes.
 * Deploy-gated: 404 until /api/validation is deployed.
 */
export function registerValidateCommands(
  parent: Command,
  getClient: () => Promise<ApiClient>
): void {
  parent
    .command("validate [profile]")
    .description(
      "Run a company-setup validation profile (jerry, betoni); omit profile or use 'list' to list profiles"
    )
    .option("--asiakas <id>", "Target asiakasId (default: active company)", Number)
    .action(async (profile: string | undefined, opts: { asiakas?: number }) => {
      try {
        const client = await getClient();
        if (!profile || profile === "list") {
          writeJson(await runValidateProfiles(client));
          return;
        }
        const asiakasId =
          opts.asiakas ?? decodeJwtPayload(client.getCurrentToken()).ownerAsiakasId;
        writeJson(await runValidate(client, profile, asiakasId));
      } catch (e) {
        exitWithError(e);
      }
    });
}
