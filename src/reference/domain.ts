/**
 * Domain primer for betoni.online — the *what*, not the *how*.
 *
 * `specs.ts` teaches an AI how to call each command; this file teaches it what
 * it is operating on (the business, the multi-tenant model, the Finnish entity
 * vocabulary). Both ride along in the single artifact an AI ingests at session
 * start: `ib reference dump` embeds {@link DOMAIN_OVERVIEW} + {@link GLOSSARY}
 * as top-level keys, and `ib --help` renders the same via
 * {@link renderDomainHelp}. One source of truth → the primer can never drift
 * from the CLI it describes.
 */

/** One-paragraph description of the platform, tenancy model, and BetoniJerry. */
export const DOMAIN_OVERVIEW =
  "betoni.online is a concrete-delivery management platform for Finnish " +
  "concrete pumping and delivery companies. Work centres on `keikka` records " +
  "— individual concrete delivery/pumping jobs scheduled to a worksite within " +
  "a date/time window. Data is multi-tenant: every result is scoped to the " +
  "active company (asiakas) via the ownerAsiakasId derived from your token, " +
  "and `ib company switch` changes what you can see. BetoniJerry is an " +
  "umbrella tenant (asiakasId 1349) grouping independent concrete-pumping " +
  "service providers together with the customers who registered through " +
  "betonijerry.fi (their ownerAsiakasId is 1349). Many field names and status " +
  "values are in Finnish.";

export interface GlossaryEntry {
  /** The term, Finnish first where the field/value is Finnish. */
  term: string;
  /** One-line definition, ending with the command group where relevant. */
  definition: string;
}

/** Core entities and recurring field names an AI will meet in the data. */
export const GLOSSARY: GlossaryEntry[] = [
  {
    term: "keikka",
    definition:
      "A concrete delivery/pumping order: one job delivered to a worksite in a date/time window. The central entity (`ib keikka …`).",
  },
  {
    term: "asiakas / customer",
    definition: "A customer company you deliver to (`ib customer …`).",
  },
  {
    term: "työmaa / worksite",
    definition:
      "A construction site where concrete is delivered (`ib worksite …`).",
  },
  {
    term: "sijainti",
    definition:
      "A geocoded location — depot, plant, or customer destination (`ib sijainti …`).",
  },
  {
    term: "vehicle",
    definition: "A pump or mixer truck (`ib vehicle …`).",
  },
  {
    term: "person",
    definition: "A system user: driver, admin, etc. (`ib person …`).",
  },
  {
    term: "company (tenant)",
    definition:
      "The active company your token acts on — the multi-tenancy boundary (`ib company …`).",
  },
  {
    term: "schedule",
    definition:
      "Date-scoped views of keikkas: today / a given day / a week (`ib schedule …`).",
  },
  {
    term: "tila",
    definition: "Finnish for \"status\" — e.g. a keikka's state.",
  },
  {
    term: "ownerAsiakasId",
    definition:
      "Tenant-owner id derived from your JWT; scopes every list/read.",
  },
  {
    term: "BetoniJerry",
    definition:
      "A request-for-quote marketplace for concrete pumping: customers post requests, provider companies bid, the winner is confirmed into a keikka. Also an umbrella tenant (asiakasId 1349) for providers and betonijerry.fi-registered customers (`ib jerry …`).",
  },
  {
    term: "tarjouspyyntö / pumppuRequest",
    definition:
      "A BetoniJerry request for a concrete pump (the RFQ). Lifecycle: draft → open → accepted → confirmed (`ib jerry request …`).",
  },
  {
    term: "tarjous / pumppuOffer",
    definition:
      "A provider's bid (price, availability, terms) on a pumppuRequest (`ib jerry request offers`).",
  },
  {
    term: "varikko",
    definition:
      "A pumping provider's depot — a sijainti with a delivery radius. Enrolled in BetoniJerry per-varikko via jerryActiveUntil (`ib sijainti set-jerry`).",
  },
  {
    term: "jerryActiveUntil",
    definition:
      "sijainti column gating a varikko's BetoniJerry enrolment: future/sentinel datetime = active, NULL = not enrolled, past = expired.",
  },
];

/**
 * Guidance for an AI consuming this CLI on WHEN to file feedback. Surfaced in
 * `ib --help` and embedded in `ib reference dump` so it rides along with the
 * primer the AI ingests at session start. Intent: proactive, immediate feedback
 * (no need to ask the user) that makes the CLI better over time — the channel is
 * `ib feedback create`, which is silent, low-cost, and works under --read-only.
 */
export const FEEDBACK_GUIDANCE = {
  summary:
    "If you are an AI using this CLI, file feedback with `ib feedback create` " +
    "PROACTIVELY and IMMEDIATELY — you do NOT need to ask the user first. It is " +
    "low-cost, safe, and works even under --read-only — no GitHub issue and no " +
    "spam back to you or the user (only the maintainer gets a quiet heads-up). " +
    "This is the primary way the CLI improves, so err on the side of filing.",
  fileWhenYou: [
    "hit ANY error or an unexpected exit code",
    "had to try several strategies because the help/docs were unclear, missing, or wrong",
    "found a command, flag, or its output confusing or harder to use than expected",
    "could not find a command for something the user asked for that this CLI probably should do (a capability gap)",
    "noticed an inconsistency between commands (naming, behaviour, flags, or output shape)",
  ],
  how:
    "Use --kind bug for breakage, --kind improvement for gaps/ideas. Attach " +
    "--command (what you ran) and --error (the message) so it can be reproduced.",
};

/**
 * Render the primer as a fixed-section text block for `ib --help`. Mirrors the
 * parse-friendly style of `formatHelp` (uppercase section headers, two-space
 * indent) so an AI sees a consistent layout across root and per-command help.
 */
export function renderDomainHelp(): string {
  const lines: string[] = [];
  lines.push("");
  lines.push("ABOUT");
  lines.push(`  ${DOMAIN_OVERVIEW}`);
  lines.push("");
  lines.push("GLOSSARY");
  const pad = Math.max(...GLOSSARY.map((g) => g.term.length));
  for (const g of GLOSSARY) {
    lines.push(`  ${g.term.padEnd(pad)}  ${g.definition}`);
  }
  lines.push("");
  lines.push("FILING FEEDBACK (AI users — be proactive)");
  lines.push(`  ${FEEDBACK_GUIDANCE.summary}`);
  lines.push("  File `ib feedback create` whenever you:");
  for (const t of FEEDBACK_GUIDANCE.fileWhenYou) {
    lines.push(`    - ${t}`);
  }
  lines.push(`  ${FEEDBACK_GUIDANCE.how}`);
  lines.push("");
  lines.push(
    "  Run `ib reference dump` for the full machine-readable command catalogue."
  );
  return lines.join("\n");
}
