import type { Command } from "commander";
import { failWith } from "../../output/json.js";

/**
 * The "resolve one geographic point" input shared by `ib opendata building`
 * and `ib opendata parcel`. Both accept the same four mutually-exclusive
 * sources, and `--tyomaa` is a spelling alias of `--worksite` (kept on both
 * commands — the Finnish spelling is what an operator reaches for).
 */
export interface PointSourceOptions {
  sijainti?: number;
  worksite?: number;
  tyomaa?: number;
  lat?: number;
  lng?: number;
  address?: string;
}

/** Attach the six point-source options, in the order both commands declare them. */
export function addPointSourceOptions(cmd: Command): Command {
  return cmd
    .option("--sijainti <id>", "", Number)
    .option("--worksite <tyomaaId>", "", Number)
    .option("--tyomaa <tyomaaId>", "", Number)
    .option("--lat <n>", "", Number)
    .option("--lng <n>", "", Number)
    .option("--address <s>");
}

/**
 * Distinct point sources the caller supplied — `--worksite`/`--tyomaa` count as
 * ONE (they are aliases), and `--lat`/`--lng` collapse to `coords` so a lone
 * half still registers as an attempt (and trips the pair guard below rather
 * than silently reading as "no source given").
 */
export function selectedPointSources(opts: PointSourceOptions): string[] {
  const sources: string[] = [];
  if (opts.sijainti !== undefined) sources.push("sijainti");
  if (opts.worksite !== undefined || opts.tyomaa !== undefined) sources.push("worksite");
  if (opts.lat !== undefined || opts.lng !== undefined) sources.push("coords");
  if (opts.address !== undefined) sources.push("address");
  return sources;
}

/**
 * The four guards both lookups run before any request, in one order:
 * at least one source, at most one source, `--lat`+`--lng` together, and the
 * two worksite spellings agreeing. `sources` is passed in (rather than
 * recomputed) because `parcel` prepends its own non-point `kiinteistotunnus`
 * source, which must be counted by the first two guards.
 *
 * `messages` carries the two wordings that genuinely differ per command —
 * parcel lists `--kiinteistotunnus` first and calls it a "source" where
 * building says "primary source".
 */
export function assertSinglePointSource(
  opts: PointSourceOptions,
  sources: string[],
  messages: { none: string; multiple: (got: string) => string }
): void {
  if (sources.length === 0) {
    failWith(messages.none, 4);
  }
  if (sources.length > 1) {
    failWith(messages.multiple(sources.join(", ")), 4);
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
}

/**
 * The five shared query params, in wire order. `--tyomaa` folds into
 * `worksite` here so the backend only ever sees one spelling.
 */
export function pointSourceParams(
  opts: PointSourceOptions
): Record<string, string | number | undefined> {
  return {
    sijainti: opts.sijainti,
    worksite: opts.worksite ?? opts.tyomaa,
    lat: opts.lat,
    lng: opts.lng,
    address: opts.address,
  };
}
