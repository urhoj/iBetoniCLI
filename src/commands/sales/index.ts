import type { Command } from "commander";
import type { ApiClient } from "../../api/client.js";
import { listEnvelope, type ListEnvelope } from "../../api/envelopes.js";
import {
  type WriteFlags,
  writeFlagsToHeaders,
  addWriteFlagsToCommand,
} from "../../api/writeFlags.js";
import { writeJson, failWith } from "../../output/json.js";
import { guarded, jsonAction } from "../_shared/action.js";
import { resolveJsonObjectBody } from "../../api/parseBody.js";
import { parseOptionalId, intFlag, numFlag } from "../../targets.js";

/**
 * `ib sales` — the betoni.online SaaS sales pipeline (system-admin CRM behind
 * /admin → Myynti). Distinct from `ib jerry admin onboarding`, which is the
 * BetoniJerry PROVIDER pipeline: the same company sits in both at independent
 * stages, selling different things.
 *
 * The weekly `suomen-betonipumppausyritykset` Cowork task is the main writer of
 * `prospect update`. It may only write company FACTS — the backend drops any
 * pipeline field (status/tier/notes/parkedUntil) that arrives on this path.
 *
 * Backend surface:
 *   GET  /api/admin/sales-prospects
 *   POST /api/admin/sales-prospects
 *   PUT  /api/admin/sales-prospects/:saasProspectId   (PATCH alias; ApiClient has no patch)
 *   GET  /api/admin/sales-customers
 */
export interface SalesProspect {
  saasProspectId: number;
  asiakasId: number | null;
  companyName: string;
  /** Display name on the asiakas row (null when the prospect is cold). */
  asiakasNimi?: string | null;
  ytunnus?: string | null;
  status: string;
  tier?: number | null;
  segment?: string | null;
  region?: string | null;
  fleetPumps?: number | null;
  staffCount?: number | null;
  revenueEur?: number | null;
  revenueYear?: number | null;
  currentSystem?: string | null;
  fitScore?: number | null;
  analysis?: string | null;
  pitchAngle?: string | null;
  parked?: boolean;
  jerryStatus?: string | null;
  [key: string]: unknown;
}

export interface SalesProspectListOptions {
  status?: string;
  tier?: number;
  segment?: string;
  search?: string;
  /** Drop the two long narrative columns — the list is otherwise ~60 KB. */
  brief?: boolean;
}

const BRIEF_OMIT = ["analysis", "pitchAngle"];

/**
 * Segment filter parity with the Myynti UI (fb#817). puminet4
 * salesProspectFilters.js treats the buckets as UNIONS, not exact matches:
 * 'pumppu'/'betoni' mean value-OR-all, and 'muu' doubles as the not-yet-typed
 * bucket (unset OR muu). Exact equality here used to return a different set
 * than the UI for the same filter name — `--segment muu` missed every row
 * still NULL, which is precisely the bucket that filter exists to surface.
 * Any other value (e.g. an explicit `all`) stays an exact match.
 */
function segmentMatches(segment: string | null | undefined, filter: string): boolean {
  if (filter === "pumppu" || filter === "betoni") return segment === filter || segment === "all";
  if (filter === "muu") return !segment || segment === "muu";
  return segment === filter;
}

/**
 * GET /api/admin/sales-prospects, shaped CLIENT-SIDE. The route deliberately
 * takes no query params (one fetch, filter locally — see the route comment), so
 * every option here is applied after the fetch.
 */
export async function runProspectList(
  client: ApiClient,
  opts: SalesProspectListOptions = {}
): Promise<ListEnvelope<SalesProspect>> {
  const rows = await client.get<SalesProspect[]>("/api/admin/sales-prospects");
  let all = Array.isArray(rows) ? rows : [];
  if (opts.status) all = all.filter((r) => r.status === opts.status);
  if (opts.tier !== undefined) all = all.filter((r) => r.tier === opts.tier);
  if (opts.segment) {
    const segmentFilter = opts.segment;
    all = all.filter((r) => segmentMatches(r.segment, segmentFilter));
  }
  if (opts.search) {
    // `.trim()` matches the Myynti UI (`q.trim().toLowerCase()`,
    // salesProspectFilters.js) — without it a padded search box and a padded
    // `--search` disagree, which is exactly the parity fb#817 exists to keep.
    const needle = opts.search.trim().toLowerCase();
    // Union of the UI's fields (companyName + asiakasNimi, fb#817) and this
    // command's original ones (ytunnus + region), so a name typed into Myynti
    // and a name typed here can never disagree.
    all = all.filter((r) =>
      [r.companyName, r.asiakasNimi, r.ytunnus, r.region].some((v) =>
        String(v ?? "").toLowerCase().includes(needle)
      )
    );
  }
  if (opts.brief) {
    all = all.map((r) => {
      const out: Record<string, unknown> = { ...r };
      for (const k of BRIEF_OMIT) delete out[k];
      return out as SalesProspect;
    });
  }
  return listEnvelope(all);
}

/** Resolve one prospect by id, --asiakas or --ytunnus. Exit 4 when ambiguous, 5 when absent. */
export async function resolveProspect(
  client: ApiClient,
  ref: { id?: number; asiakas?: number; ytunnus?: string }
): Promise<SalesProspect> {
  // Guarded HERE, not at each call site: an all-undefined ref would otherwise
  // fall through to the ytunnus branch, where normYtunnus(undefined) === "" and
  // matches every row with a blank ytunnus. Whitespace-only is empty too
  // (fb#819): normYtunnus(" ") === "" would match an arbitrary row whose stored
  // ytunnus is null, so the guard rejects it before the lookup runs.
  if (ref.id === undefined && ref.asiakas === undefined && !ref.ytunnus?.trim()) {
    failWith("Pass a saasProspectId, --asiakas <id> or --ytunnus <y>", 4);
  }
  const rows = await client.get<SalesProspect[]>("/api/admin/sales-prospects");
  const all = Array.isArray(rows) ? rows : [];
  // Y-tunnus rendering varies by source: seeded rows took theirs from `asiakas`
  // (hyphenated, "1869376-5"), the weekly registry-scrape task takes theirs from
  // markdown (sometimes unhyphenated, "18693765"). Compare digits-only so both
  // resolve to the same row — an exact-string miss here used to exit 5 and send
  // the weekly task down the `add` path, creating a duplicate prospect for a
  // company already in the pipeline. Digit-only normalization is for THIS
  // lookup only; stored values are left exactly as provided.
  const normYtunnus = (v: unknown): string => String(v ?? "").replace(/\D/g, "");
  const matches = ref.id !== undefined
    ? all.filter((r) => r.saasProspectId === ref.id)
    : ref.asiakas !== undefined
      ? all.filter((r) => r.asiakasId === ref.asiakas)
      : all.filter((r) => normYtunnus(r.ytunnus) === normYtunnus(ref.ytunnus));
  if (matches.length === 0) {
    failWith(`No sales prospect matches ${JSON.stringify(ref)}`, 5);
  }
  if (matches.length > 1) {
    // Never guess: two rows for one ytunnus means the data needs fixing, and
    // picking one would write the analysis onto an arbitrary half of it.
    failWith(
      `Ambiguous: ${matches.length} prospects match ${JSON.stringify(ref)} (ids ${matches
        .map((m) => m.saasProspectId)
        .join(", ")}) — pass the saasProspectId`,
      4
    );
  }
  return matches[0]!;
}

/** Fields the weekly task may write. Anything else is dropped by the backend. */
export interface SalesProspectFactFields {
  companyName?: string;
  ytunnus?: string;
  segment?: string;
  region?: string;
  fleetPumps?: number;
  staffCount?: number;
  revenueEur?: number;
  revenueYear?: number;
  currentSystem?: string;
  analysis?: string;
  /** First-fill: written only while the stored value is NULL. */
  fitScore?: number;
  /** First-fill: written only while the stored value is NULL. */
  pitchAngle?: string;
}

export async function runProspectUpdate(
  client: ApiClient,
  saasProspectId: number,
  fields: SalesProspectFactFields,
  flags: WriteFlags
): Promise<unknown> {
  return client.put<unknown>(
    `/api/admin/sales-prospects/${saasProspectId}`,
    { ...fields, scope: "task" },
    { headers: writeFlagsToHeaders(flags) }
  );
}

export async function runProspectAdd(
  client: ApiClient,
  body: Record<string, unknown>,
  flags: WriteFlags
): Promise<unknown> {
  return client.post<unknown>("/api/admin/sales-prospects", body, {
    headers: writeFlagsToHeaders(flags),
  });
}

export async function runCustomerList(client: ApiClient): Promise<ListEnvelope<unknown>> {
  const rows = await client.get<unknown[]>("/api/admin/sales-customers");
  return listEnvelope(Array.isArray(rows) ? rows : []);
}

export function registerSalesCommands(
  parent: Command,
  getClient: () => Promise<ApiClient>
): void {
  const s = parent
    .command("sales")
    .description(
      "betoni.online SaaS sales pipeline (system admin) — prospects + the companies actually running keikkaa. NOT `jerry admin onboarding`, which is the BetoniJerry provider pipeline."
    );

  const prospect = s.command("prospect").description("SaaS sales prospects (dbo.saasProspect)");

  prospect
    .command("list")
    .option("--status <s>")
    .option("--tier <n>", "", intFlag("--tier"))
    .option("--segment <s>")
    .option("--search <text>")
    .option("--brief", "omit analysis + pitchAngle (the two long columns)")
    .action(jsonAction(getClient, (client, opts: SalesProspectListOptions) => runProspectList(client, opts)));

  prospect
    .command("get [saasProspectId]")
    // `show` — the reflex spelling for read-one-row (fb#836).
    .alias("show")
    .option("--asiakas <id>", "", intFlag("--asiakas"))
    .option("--ytunnus <y>")
    .action(
      jsonAction(getClient, (client, idArg: string | undefined, opts: { asiakas?: number; ytunnus?: string }) =>
        resolveProspect(client, {
          id: parseOptionalId(idArg, "saasProspectId"),
          asiakas: opts.asiakas,
          ytunnus: opts.ytunnus,
        })
      )
    );

  const addCmd = prospect
    .command("add")
    .option("--asiakas <id>", "", intFlag("--asiakas"))
    .option("--name <s>")
    .option("--ytunnus <y>")
    .option("--segment <s>")
    .option("--tier <n>", "", intFlag("--tier"))
    .option("--region <s>");
  addWriteFlagsToCommand(addCmd).action(
    guarded(async (opts: WriteFlags & { asiakas?: number; name?: string; ytunnus?: string; segment?: string; tier?: number; region?: string }) => {
      if (opts.asiakas === undefined && !opts.name) {
        failWith("Pass --asiakas <id> or --name \"<company>\"", 4);
      }
      const client = await getClient();
      writeJson(
        await runProspectAdd(
          client,
          {
            asiakasId: opts.asiakas,
            companyName: opts.name,
            ytunnus: opts.ytunnus,
            segment: opts.segment,
            tier: opts.tier,
            region: opts.region,
            source: "scheduled",
          },
          opts
        )
      );
    })
  );

  const updateCmd = prospect
    .command("update [saasProspectId]")
    .option("--asiakas <id>", "", intFlag("--asiakas"))
    .option("--ytunnus <y>")
    .option("--name <s>")
    .option("--segment <s>")
    .option("--region <s>")
    .option("--fleet-pumps <n>", "", intFlag("--fleet-pumps", 0))
    .option("--staff <n>", "", intFlag("--staff", 0))
    .option("--revenue <eur>", "", numFlag("--revenue"))
    .option("--revenue-year <y>", "", intFlag("--revenue-year"))
    .option("--current-system <s>")
    .option("--analysis <text>")
    .option("--fit-score <n>", "", numFlag("--fit-score"))
    .option("--pitch <text>")
    // The shell-safe route for long Finnish prose. `--from-json` is NOT part of
    // addWriteFlagsToCommand (that adds only --dry-run/--idempotency-key/--reason),
    // so it is declared here — and the weekly task depends on it: PowerShell splits
    // an argument on its inner double quotes and silently expands backticks, both
    // of which an --analysis paragraph is full of.
    .option("--body <json>")
    .option("--from-json <file|->");
  addWriteFlagsToCommand(updateCmd).action(
    guarded(async (
      idArg: string | undefined,
      opts: WriteFlags & {
        asiakas?: number; ytunnus?: string; name?: string; segment?: string; region?: string;
        fleetPumps?: number; staff?: number; revenue?: number; revenueYear?: number;
        currentSystem?: string; analysis?: string; fitScore?: number; pitch?: string;
        body?: string; fromJson?: string;
      }
    ) => {
      const client = await getClient();
      const id = parseOptionalId(idArg, "saasProspectId");
      const row = await resolveProspect(client, { id, asiakas: opts.asiakas, ytunnus: opts.ytunnus });
      // Typed flags win over the JSON document — the same precedence as
      // buildOhjeFields/buildSijaintiBody, so a one-off override on the command
      // line does not need the file edited.
      const parsed = (resolveJsonObjectBody({ body: opts.body, fromJson: opts.fromJson })
        ?? {}) as SalesProspectFactFields;
      const fields: SalesProspectFactFields = {
        companyName: opts.name ?? parsed.companyName,
        // JSON-document only: --ytunnus is a resolve-by KEY on this command
        // (which row to update), never a value to WRITE, so it must not be
        // merged in here the way the other typed flags are.
        ytunnus: parsed.ytunnus,
        segment: opts.segment ?? parsed.segment,
        region: opts.region ?? parsed.region,
        fleetPumps: opts.fleetPumps ?? parsed.fleetPumps,
        staffCount: opts.staff ?? parsed.staffCount,
        revenueEur: opts.revenue ?? parsed.revenueEur,
        revenueYear: opts.revenueYear ?? parsed.revenueYear,
        currentSystem: opts.currentSystem ?? parsed.currentSystem,
        analysis: opts.analysis ?? parsed.analysis,
        fitScore: opts.fitScore ?? parsed.fitScore,
        pitchAngle: opts.pitch ?? parsed.pitchAngle,
      };
      writeJson(await runProspectUpdate(client, row.saasProspectId, fields, opts));
    })
  );

  const customer = s
    .command("customer")
    .description("Companies with their own keikka rows — who is actually running betoni.online");

  customer
    .command("list")
    .action(jsonAction(getClient, (client) => runCustomerList(client)));
}
