/**
 * `ib reference detail …` — the AI's on-demand business-context surface, now
 * DB-backed via /api/cli/command-catalog (was local `spec.detail`). The detail
 * tier no longer lives in betonicli source; it is read/written over the API so
 * the optimize-ib-summaries routine needs only an IB_TOKEN (no git).
 */
import type { ApiClient } from "../api/client.js";
import { COMMAND_SPECS } from "./specs.js";
import { CliError } from "../api/errors.js";
import { type CallerTier, visibleSpecs, getCallerTier } from "../tier.js";
import { writeFlagsToHeaders, type WriteFlags } from "../api/writeFlags.js";

function resolveCommand(commandParts: string[], tier: CallerTier): string {
  const command = `ib ${commandParts.join(" ")}`.trim();
  const visible = visibleSpecs(COMMAND_SPECS, tier).some((s) => s.command === command);
  if (!visible) {
    throw new CliError(`unknown command: ${command}. Use \`ib commands\` for valid paths.`, 0, null, 5);
  }
  return command;
}

export async function runReferenceDetail(
  client: ApiClient,
  commandParts: string[],
  tier: CallerTier = getCallerTier()
): Promise<{ command: string; summary: string | null; detail: string; hint: string }> {
  const command = resolveCommand(commandParts, tier);
  return client.get(`/api/cli/command-catalog/${encodeURIComponent(command)}`);
}

export async function runReferenceDetailList(
  client: ApiClient,
  stalest?: number,
  domain?: string
): Promise<{ items: Array<{ command: string; summary: string | null; lastReviewed: string | null; runs: number }>; count: number }> {
  const p = new URLSearchParams();
  if (stalest) p.set("stalest", String(stalest));
  if (domain) p.set("domain", domain);
  const q = p.toString();
  return client.get(`/api/cli/command-catalog${q ? `?${q}` : ""}`);
}

export async function runReferenceDetailSet(
  client: ApiClient,
  commandParts: string[],
  body: { summary?: string; detail?: string },
  flags: WriteFlags = {},
  tier: CallerTier = getCallerTier()
): Promise<unknown> {
  // Same client-side visibility gate as the read: an unknown (or tier-hidden)
  // command exits 5 before any write leaves the process.
  const command = resolveCommand(commandParts, tier);
  return client.put(`/api/cli/command-catalog/${encodeURIComponent(command)}`, body, {
    headers: writeFlagsToHeaders(flags),
  });
}
