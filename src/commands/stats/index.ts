import type { Command } from "commander";
import type { ApiClient } from "../../api/client.js";
import { writeJson, exitWithError } from "../../output/json.js";
import { resolveDate, monthRange, weekRange, todayHelsinki } from "../../dates.js";
import { CliError } from "../../api/errors.js";

export const STATS_DIMS = ["customer", "vehicle", "driver", "worksite", "status", "day"] as const;
export type StatsDim = (typeof STATS_DIMS)[number];

export interface StatsOptions {
  from?: string;
  to?: string;
  today?: boolean;
  month?: string;
  week?: string;
  by?: string;
  all?: boolean;
}

/**
 * Resolve the mutually-exclusive period flags to a concrete { from, to } range.
 * Exactly one of: --today | --month | --week | (--from AND --to). None ⇒ today.
 * Throws CliError(exit 4) on conflicting or half-specified ranges.
 */
export function resolveStatsPeriod(opts: StatsOptions): { from: string; to: string } {
  const groups =
    (opts.today ? 1 : 0) +
    (opts.month ? 1 : 0) +
    (opts.week ? 1 : 0) +
    (opts.from || opts.to ? 1 : 0);
  if (groups > 1) {
    throw new CliError("Use only one of --today / --month / --week / (--from & --to)", 0, null, 4);
  }
  if (opts.today) {
    const t = todayHelsinki();
    return { from: t, to: t };
  }
  if (opts.month) return monthRange(opts.month);
  if (opts.week) return weekRange(resolveDate(opts.week) as string);
  if (opts.from || opts.to) {
    if (!opts.from || !opts.to) {
      throw new CliError("--from and --to must be given together", 0, null, 4);
    }
    return { from: resolveDate(opts.from) as string, to: resolveDate(opts.to) as string };
  }
  const t = todayHelsinki();
  return { from: t, to: t };
}

/** GET /api/cli/stats. No --by → full bundle object; --by X → list envelope. */
export async function runStats(client: ApiClient, opts: StatsOptions): Promise<unknown> {
  const { from, to } = resolveStatsPeriod(opts);
  const params = new URLSearchParams({ from, to });
  if (opts.by) {
    if (!STATS_DIMS.includes(opts.by as StatsDim)) {
      throw new CliError(`--by must be one of: ${STATS_DIMS.join(", ")}`, 0, null, 4);
    }
    params.set("by", opts.by);
  }
  if (opts.all) {
    params.set("all", "1");
  }
  return client.get<unknown>(`/api/cli/stats?${params.toString()}`);
}

/**
 * Register `ib stats` — one read-only aggregate command with period sugar and
 * --by slicing. Deploy-gated: returns 404 until GET /api/cli/stats is deployed.
 */
export function registerStatsCommands(parent: Command, getClient: () => Promise<ApiClient>): void {
  parent
    .command("stats")
    .description("Aggregated delivery statistics (volume, counts, breakdowns) for a date range")
    .option("--from <date>", "Start date YYYY-MM-DD (or today/yesterday/tomorrow)")
    .option("--to <date>", "End date YYYY-MM-DD (or today/yesterday/tomorrow)")
    .option("--today", "Shortcut for --from today --to today")
    .option("--month <YYYY-MM>", "Whole calendar month (expands to first→last day)")
    .option("--week <start>", "7-day window starting <start> (YYYY-MM-DD)")
    .option("--by <dim>", `Single breakdown: ${STATS_DIMS.join("|")} (omit for full bundle)`)
    .option("--all", "All tenants (requires developer/system-admin access; 403 otherwise)")
    .action(async (opts: StatsOptions) => {
      try {
        const client = await getClient();
        const result = await runStats(client, opts);
        writeJson(result);
      } catch (e) {
        exitWithError(e);
      }
    });
}
