import type { Command } from "commander";
import type { ApiClient } from "../../api/client.js";
import { writeJson, exitWithError, failWith } from "../../output/json.js";

export interface ParcelLookupOptions {
  kiinteistotunnus?: string;
  sijainti?: number;
  worksite?: number;
  tyomaa?: number;
  lat?: number;
  lng?: number;
  address?: string;
  withBuildings?: boolean;
}

/** Distinct primary sources the caller supplied (exactly one allowed). */
function selectedSources(opts: ParcelLookupOptions): string[] {
  const sources: string[] = [];
  if (opts.kiinteistotunnus !== undefined) sources.push("kiinteistotunnus");
  if (opts.sijainti !== undefined) sources.push("sijainti");
  if (opts.worksite !== undefined || opts.tyomaa !== undefined) sources.push("worksite");
  if (opts.lat !== undefined || opts.lng !== undefined) sources.push("coords");
  if (opts.address !== undefined) sources.push("address");
  return sources;
}

/**
 * GET /api/cli/opendata/parcel/lookup — resolve a cadastral parcel (kiinteistö /
 * palsta) from EITHER a kiinteistötunnus (direct, no geocode) OR one point
 * source (sijainti / worksite / lat+lng / address). Returns the parcel
 * polygon(s), MML presentation-form id and a computed area (m²).
 */
export async function runParcelLookup(
  client: ApiClient,
  opts: ParcelLookupOptions
): Promise<Record<string, unknown>> {
  const params = new URLSearchParams();
  const worksite = opts.worksite ?? opts.tyomaa;
  if (opts.kiinteistotunnus !== undefined) params.set("kiinteistotunnus", opts.kiinteistotunnus);
  if (opts.sijainti !== undefined) params.set("sijainti", String(opts.sijainti));
  if (worksite !== undefined) params.set("worksite", String(worksite));
  if (opts.lat !== undefined) params.set("lat", String(opts.lat));
  if (opts.lng !== undefined) params.set("lng", String(opts.lng));
  if (opts.address !== undefined) params.set("address", opts.address);
  if (opts.withBuildings) params.set("withBuildings", "1");
  return client.get<Record<string, unknown>>(
    `/api/cli/opendata/parcel/lookup?${params.toString()}`
  );
}

/** Register `ib opendata parcel`. */
export function registerParcelCommands(
  parent: Command,
  getClient: () => Promise<ApiClient>
): void {
  parent
    .command("parcel")
    .description(
      "Cadastral parcel (kiinteistö/palsta) lookup from MML — by kiinteistötunnus or a sijainti/worksite/address/lat+lng point; returns boundaries + computed area anywhere in Finland"
    )
    .option(
      "--kiinteistotunnus <tunnus>",
      "Property identifier, dashed or 14-digit — direct lookup (no geocode)"
    )
    .option("--sijainti <id>", "Resolve coordinates from a sijainti id", Number)
    .option("--worksite <tyomaaId>", "Resolve coordinates from a worksite (tenant-scoped)", Number)
    .option("--tyomaa <tyomaaId>", "Alias for --worksite", Number)
    .option("--lat <n>", "Latitude (WGS84) — pair with --lng", Number)
    .option("--lng <n>", "Longitude (WGS84) — pair with --lat", Number)
    .option("--address <s>", "Street address to geocode")
    .option(
      "--with-buildings",
      "Also count buildings on the parcel (national Ryhti; permit-based, best-effort)"
    )
    .action(async (opts: ParcelLookupOptions) => {
      const sources = selectedSources(opts);
      if (sources.length === 0) {
        failWith(
          "provide exactly one of: --kiinteistotunnus, --sijainti, --worksite, --lat+--lng, or --address",
          4
        );
      }
      if (sources.length > 1) {
        failWith(`provide exactly one source (got: ${sources.join(", ")})`, 4);
      }
      if (sources[0] === "coords" && (opts.lat === undefined || opts.lng === undefined)) {
        failWith("--lat and --lng must be provided together", 4);
      }
      if (
        opts.worksite !== undefined &&
        opts.tyomaa !== undefined &&
        opts.worksite !== opts.tyomaa
      ) {
        failWith("--worksite and --tyomaa disagree; pass only one", 4);
      }
      try {
        const client = await getClient();
        writeJson(await runParcelLookup(client, opts));
      } catch (e) {
        exitWithError(e);
      }
    });
}
