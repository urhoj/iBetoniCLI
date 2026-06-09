/**
 * `ib commands` — a filtered, offline view over the {@link COMMAND_SPECS}
 * catalogue.
 *
 * `ib reference dump` emits the entire surface (every flag, error, example) for
 * one-shot ingestion; `ib commands` is the lightweight discovery counterpart —
 * "which commands write?", "which are read-only?", "which need permission X?" —
 * returning just `{ command, description, permissions, writeFlags }` per match.
 * Pure and offline (no auth, no network); the source of truth is the same
 * `COMMAND_SPECS` so this never drifts from `--help` / `reference dump`.
 */
import type { CommandSpec } from "../output/help.js";
import { COMMAND_SPECS } from "./specs.js";
import { CliError } from "../api/errors.js";

/** Compact per-command summary surfaced by `ib commands`. */
export interface CommandSummary {
  command: string;
  description: string;
  permissions: string[];
  /** True when the command mutates (writes) data. */
  writeFlags: boolean;
}

/** Filter inputs for {@link filterCommandSpecs}. */
export interface CommandsListFilter {
  /** Keep only mutating commands (mutates:true, or writeFlags:true when mutates is absent). */
  mutations?: boolean;
  /** Keep only non-mutating (read-only) commands. */
  reads?: boolean;
  /** Keep only commands whose permission strings contain this substring. */
  permission?: string;
}

/** List-envelope shape (matches the universal `{ items, nextCursor, count }`). */
export interface CommandsListEnvelope {
  items: CommandSummary[];
  nextCursor: null;
  count: number;
}

/**
 * Filter {@link CommandSpec}s down to the compact {@link CommandSummary} shape.
 * `--mutations` and `--reads` are mutually exclusive (a command cannot be both);
 * passing both is a validation error (exit 4). `permission` matches a
 * case-insensitive substring against each spec's `permissions` entries.
 */
export function filterCommandSpecs(
  specs: CommandSpec[],
  filter: CommandsListFilter
): CommandSummary[] {
  if (filter.mutations && filter.reads) {
    throw new CliError(
      "--mutations and --reads are mutually exclusive",
      0,
      null,
      4
    );
  }
  const needle = filter.permission?.toLowerCase();
  return specs
    .filter((s) => {
      const mutates = s.mutates ?? !!s.writeFlags;
      if (filter.mutations && !mutates) return false;
      if (filter.reads && mutates) return false;
      if (needle && !s.permissions?.some((p) => p.toLowerCase().includes(needle))) {
        return false;
      }
      return true;
    })
    .map((s) => ({
      command: s.command,
      description: s.description,
      permissions: s.permissions ?? [],
      writeFlags: s.mutates ?? !!s.writeFlags,
    }));
}

/**
 * Build the `ib commands` envelope from the live {@link COMMAND_SPECS}. Pure —
 * callers (`program.ts`) handle stdout via `writeJson`.
 */
export function buildCommandsList(
  filter: CommandsListFilter
): CommandsListEnvelope {
  const items = filterCommandSpecs(COMMAND_SPECS, filter);
  return { items, nextCursor: null, count: items.length };
}
