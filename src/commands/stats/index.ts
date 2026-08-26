import type { Command } from "commander";
import type { ApiClient } from "../../api/client.js";
import { resolveDate, monthRange, weekRange, todayHelsinki } from "../../dates.js";
import { CliError } from "../../api/errors.js";
import { assertEnum } from "../../targets.js";
import { qs } from "../../api/query.js";
import { jsonAction } from "../_shared/action.js";
export const STATS_DIMS = ["customer", "vehicle", "driver", "worksite", "status", "day"] as const;

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
  // `--today` needs no branch: it is exactly the no-period default below.
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
  if (opts.by) assertEnum(opts.by, STATS_DIMS, "--by");
  return client.get<unknown>(
    `/api/cli/stats${qs({
      from,
      to,
      by: opts.by || undefined,
      all: opts.all ? 1 : undefined,
    })}`
  );
}

/**
 * Register `ib stats` — one read-only aggregate command with period sugar and
 * --by slicing. Deploy-gated: returns 404 until GET /api/cli/stats is deployed.
 */
export function registerStatsCommands(parent: Command, getClient: () => Promise<ApiClient>): void {
  parent
    .command("stats")
    .option("--from <date>")
    .option("--to <date>")
    .option("--today")
    .option("--month <YYYY-MM>")
    .option("--week <start>")
    .option("--by <dim>")
    .option("--all")
    .action(jsonAction(getClient, (client, opts: StatsOptions) => runStats(client, opts)));
}
