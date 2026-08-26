// sijainti specs — split from the monolithic specs.ts (fb#782). The barrel
// (src/reference/specs.ts) spreads every segment in a fixed sequence; order
// within this file is load-bearing (catalogue order drives sibling-suggestion
// ranking and the parse-guard-hint snapshots).
import type { CommandSpec } from "../../output/help.js";
import { apiErr, limitErr, COMMON_AUTH_ERRORS, permErrors, SIJAINTI_PUBLIC_403_MATCH, GEOCODE_CLIENT_ERR, puomiErr, GEOCODE_NO_ADDRESS_ERR, REASON_REQUIRED_FLAG, LIMIT_500_FLAG } from "./shared.js";

export const SIJAINTI_SPECS: CommandSpec[] = [

  // ─── sijainti (14) ───────────────────────────────────────────────────────
  {
    command: "ib sijainti list",
    description:
      "List geocoded locations (sijainnit) — depots, plants, customer destinations. Rows carry a human-readable typeName. --type filters by sijaintiTypeId OR type name (e.g. betoniasema, jäteasema); --search filters by name/address/typeName substring. Default scope is own company + shared rows; pass --all to also see OTHER companies' sijainnit (e.g. supplier betoniasemat — the rows GPS visits/timeline reference).",
    permissions: ["auth.page.sijainnit.read"],
    flags: [
      { name: "type", type: "string", description: "Filter by sijaintiTypeId or type name (case-insensitive; exact selite match wins, else unique substring — see `ib sijainti types`)" },
      { name: "search", type: "string", description: "Case-insensitive substring over name/address/typeName (client-side scan up to 500 rows; newer backends also pre-filter server-side)" },
      LIMIT_500_FLAG,
      { name: "valid-at", type: "date", description: "Only sijainnit valid on this date (startDate/endDate window)" },
      { name: "include-deleted", type: "boolean", description: "Include soft-deleted sijainnit" },
      { name: "all", type: "boolean", description: "Include ALL companies' sijainnit, not just own + shared (ownerAsiakasId 0)" },
      { name: "asiakas", type: "number", description: "Only rows owned by this asiakasId (client-side filter on ownerAsiakasId; combine with --all for another company's rows)" },
      { name: "jerry", type: "boolean", description: "BetoniJerry audit lens: only Jerry-enrolled varikot (jerryActiveUntil set; expired included), each stamped with a derived `matchable` boolean" },
      { name: "public", type: "boolean", description: "Only PUBLISHED rows (isPublic=1) — readable cross-tenant by every authenticated user" },
      { name: "private", type: "boolean", description: "Only private rows (isPublic=0) — visible to the owning tenant alone. Mutually exclusive with --public" },
    ],
    outputShape:
      "ListEnvelope<{ sijaintiId, name, address, coords:{lat,lng}, type, typeName, ownerAsiakasId, ownerName, jerryActiveUntil, maxDeliveryDistance, isPublic }> (+matchable:boolean on each row when --jerry is set; +truncated:true when the result hit the limit; +hint pointing at --all / --all --asiakas <id> when 0 rows came back without --all)",
    errors: [
      limitErr("pass a positive integer; this command caps at 500, so narrow by type rather than raising the cap"),
      { origin: "client", exit: 4, match: "sijainti type", meaning: "Unknown or ambiguous --type name", remedy: "the error lists the valid types; or run `ib sijainti types`" },
      { origin: "client", exit: 4, match: "at most one of --public", meaning: "Both --public and --private given", remedy: "pass at most one — omit both to filter nothing" },
      ...permErrors("auth.page.sijainnit.read"),
    ],
    notes: [
      "The list is capped (default 100 / max 500) with NO cursor — `truncated:true` flags a result that filled the limit (raise --limit or narrow with --search/--type). Backend signal needs a backend deployed ≥ 2026-06-11; the client-side --search slice sets it on every backend.",
      "typeName is joined client-side from the sijaintiTypes lookup (one extra GET, automatic); newer backends also emit it directly, plus ownerAsiakasId/ownerName.",
      "jerryActiveUntil (enrolment) + coords + maxDeliveryDistance (km delivery radius) are the set required for a Jerry-enabled varikko to be matchable — a row that is Jerry-active but has null coords or maxDeliveryDistance covers nothing. maxDeliveryDistance is deploy-gated (null on backends older than 2026-07-07). The optional boom range (puomiMin/puomiMax) is NOT in the list — get it via `ib sijainti get <id>`.",
      "Supplier locations (betoniasemat, depots) usually belong to ANOTHER company — without --all they are invisible here even though `ib vehicle visits sijainti <id>` and the GPS timeline reference them. To resolve such a location by name use --search <name> --all, or --all --asiakas <id> when you know the owner company. An empty result without --all carries a `hint` saying exactly this.",
      "--all needs a backend deployed ≥ 2026-06-10; an older backend silently ignores it (returns the own+shared scope). --search works on every backend (client-side fallback).",
      "An unknown numeric --type id is passed through and simply returns zero rows; an unknown type NAME exits 4.",
      "--asiakas filters client-side on the server-emitted ownerAsiakasId field — needs a backend deployed ≥ 2026-06-11 (older backends omit the field, so it matches nothing).",
      "--jerry (fb#108) is a client-side BetoniJerry audit lens: keeps only Jerry-ENROLLED rows (jerryActiveUntil non-null; expired enrolments INCLUDED so lapsed varikot surface) and stamps each with `matchable` = enrolment active (jerryActiveUntil >= now) AND coords present AND maxDeliveryDistance > 0. So `matchable:false` spots an enrolled-but-not-matchable varikko (expired, no GPS pin, or 0 km radius) in ONE command. Boom range (puomiMin/puomiMax) is NOT part of matchable — use `ib sijainti get <id>`.",
      "isPublic is CROSS-TENANT VISIBILITY, not a display preference: 1 = readable by every authenticated user of every tenant (this is how the keikka flow finds a supplier's concrete plants), 0 = the owning tenant only. It moved from the location TYPE to the ROW on 2026-08-14, so two plants of the same type can now differ.",
      "--public/--private filter client-side on isPublic and are DEPLOY-GATED: a backend older than the per-row change omits the field entirely, so there --public matches NOTHING and --private matches EVERYTHING. Check one row carries isPublic before trusting a sweep.",
      "`ib sijainti list --type betoniasema --all --private` is the exposure audit: it names every concrete plant that customers CANNOT see. That is the silent failure mode — a plant created private simply never appears in the tehdas picker, and the keikka editor quietly auto-selects a farther one instead of erroring.",
    ],
    seeAlso: ["ib sijainti plants", "ib sijainti types", "ib sijainti set-jerry", "ib sijainti set-public", "ib search", "ib vehicle visits", "ib vehicle timeline"],
    examples: [
      "ib sijainti list",
      "ib sijainti list --type jäteasema",
      "ib sijainti list --search kivikko --all",
      "ib sijainti list --all --asiakas 30",
      "ib sijainti list --valid-at today",
      "ib sijainti list --jerry",
      "ib sijainti list --type betoniasema --all --private",
    ],
  },
  {
    command: "ib sijainti plants",
    aliases: ["ib sijainti tehtaat"],
    description:
      "List concrete plants (betoniasemat) across ALL companies — sugar for `sijainti list --type betoniasema --all`. Plants belong to supplier companies (Rudus, Lujabetoni, Betset, …), so the default own+shared list scope hides nearly all of them; this command surfaces the whole catalogue. --asiakas narrows to a single company's plants. Alias: `ib sijainti tehtaat`.",
    permissions: ["auth.page.sijainnit.read"],
    flags: [
      { name: "asiakas", type: "number", description: "Only this company's plants (numeric asiakasId; client-side filter on ownerAsiakasId)" },
      { name: "search", type: "string", description: "Case-insensitive substring over name/address (same semantics as `list --search`)" },
      LIMIT_500_FLAG,
    ],
    outputShape:
      "ListEnvelope<{ sijaintiId, name, address, coords:{lat,lng}, type, typeName, ownerAsiakasId, ownerName, jerryActiveUntil }> (+truncated:true when the result hit the limit)",
    errors: [
      { origin: "client", exit: 4, meaning: "--asiakas is not a positive integer", remedy: "pass a numeric asiakasId (see ownerAsiakasId in the output, or resolve the company via `ib search <name>`)" },
      ...permErrors("auth.page.sijainnit.read"),
    ],
    notes: [
      "Synonyms: plant = factory = tehdas = (betoni)asema — Finnish users say tehdas or asema for the same thing, so 'Mitkä autot kävi Kivikon asemalla?' means the Kivikko betoniasema (resolve it here, then `ib vehicle visits sijainti <id>`).",
      "Needs a backend deployed ≥ 2026-06-11 (scope=all + the ownerAsiakasId field); on an older backend the result silently falls back to the own+shared scope and --asiakas matches nothing.",
      "The plant type is resolved by NAME (betoniasema) through the sijaintiTypes lookup, not a hardcoded id.",
      "`truncated:true` flags a capped result — same semantics as `sijainti list`.",
    ],
    seeAlso: ["ib sijainti list", "ib sijainti types", "ib search", "ib vehicle visits"],
    examples: [
      "ib sijainti plants",
      "ib sijainti plants --asiakas 30",
      "ib sijainti plants --search kivikko",
      "ib sijainti tehtaat",
    ],
  },
  {
    command: "ib sijainti get",
    aliases: ["ib sijainti show"],
    description: "Get a single sijainti by id.",
    permissions: ["auth.page.sijainnit.read"],
    args: [{ name: "sijaintiId", type: "number", description: "sijaintiId to fetch" }],
    flags: [],
    outputShape:
      "{ sijaintiId, name, address, coords:{lat,lng}, type, jerryActiveUntil, ... } (raw row)",
    errors: [
      apiErr(404, "Sijainti not found", "verify sijaintiId"),
      ...permErrors("auth.page.sijainnit.read"),
    ],
    examples: ["ib sijainti get 42"],
  },
  {
    command: "ib sijainti dashboard",
    description:
      "One-shot Address Information Dashboard report for a sijainti (location) — merges weather, building, cadastral parcel, nearby traffic cameras, nearby sijainnit, worksite deliveries, and nearby vehicles into a single JSON, with each section independently degrading to forbidden/error instead of failing the whole report. Resolve the point from EXACTLY ONE of the positional sijaintiId or --address.",
    auth: "any",
    args: [
      {
        name: "sijaintiId",
        type: "number",
        required: false,
        description: "sijaintiId to report on (mutually exclusive with --address)",
      },
    ],
    flags: [
      {
        name: "address",
        type: "string",
        description: "Street address to resolve the point from, instead of sijaintiId (mutually exclusive)",
      },
    ],
    outputShape:
      "{ point:{lat,lng}|null, address:string|null, weather, building, parcel, cameras, sijainti, deliveries, vehicles } — each section is { status:'ok'|'empty'|'forbidden'|'error', data?, error? }; a forbidden/error section never fails the whole command",
    errors: [
      { origin: "client", exit: 4, meaning: "Missing or ambiguous point input", remedy: "pass exactly one of <sijaintiId> or --address" },
      ...COMMON_AUTH_ERRORS,
    ],
    notes: [
      "Per-section gating mirrors the FE dashboard: weather/cameras/vehicles degrade to forbidden when the company module is off; building/parcel are open to any authenticated user; a bad address or unresolvable point degrades EVERY section to error instead of failing the command.",
      "The `sijainti` section reports sijainnit found NEARBY the resolved point (~2 km) — unrelated to the sijaintiId positional used to resolve the point itself.",
      "`deliveries` reports worksite (tyomaa) delivery volume near the point; `vehicles` reports nearby BetoniJerry ecofleet vehicles.",
    ],
    seeAlso: ["ib worksite dashboard", "ib opendata building", "ib opendata parcel", "ib sijainti list"],
    examples: [
      "ib sijainti dashboard 42",
      'ib sijainti dashboard --address "Oraspolku 2, Helsinki"',
    ],
  },
  {
    command: "ib sijainti create",
    description:
      "Create a new sijainti (POST /api/geocode/sijainti/add). REQUIRED: --name (sijaintiNimi) and --type (sijaintiTypeId). The CLI auto-fills the other NOT NULL columns the add proc needs: --lyh defaults to --name (truncated to 50 chars), --max-distance is the general delivery radius in km (default 50; independent of BetoniJerry enrolment), and --asiakas to your active company. Coordinates (--lat/--lng or --geocode) are persisted via a follow-up updateLatLng call (the add proc binds no lat/lng) and echoed as { lat, lng, coordsPersisted } so geocoding is verifiable without a re-read. Provide typed flags or --body JSON; typed flags win over --body.",
    permissions: ["auth.page.sijainnit.edit"],
    flags: [
      { name: "body", type: "json", description: "JSON object with the new sijainti fields (optional if typed flags given) ⚠ Windows PowerShell splits this argument on its inner double-quotes, so inline JSON arrives mangled and exits 4 as a too-many-arguments usage error — use --from-json <file|-> there, or typed flags (fb#437; see `ib help shell-quoting`)." },
      { name: "name", type: "string", description: "sijaintiNimi (REQUIRED)" },
      { name: "address", type: "string", description: "sijaintiOsoite1 (street)" },
      { name: "type", type: "number", description: "sijaintiTypeId (REQUIRED; see `ib sijainti types`)" },
      { name: "lat", type: "number", description: "Latitude (persisted via updateLatLng + echoed)" },
      { name: "lng", type: "number", description: "Longitude (persisted via updateLatLng + echoed)" },
      { name: "lyh", type: "string", description: "sijaintiLyh — short code/abbreviation, ≤50 chars (defaults to --name)" },
      { name: "max-distance", type: "number", description: "Delivery radius in km, stored as maxDeliveryDistance (default 50; not Jerry-only)" },
      { name: "asiakas", type: "number", description: "Owner asiakasId (defaults to your active company)" },
      { name: "puomi-min", type: "number", description: "puomiMin (m) — STORED ONLY, not used for matching (fb#415): no pump has a boom minimum, so a floor could only hide you from work you can do" },
      { name: "puomi-max", type: "number", description: "puomiMax — largest boom (m) served from this sijainti (BetoniJerry matching; empty = unbounded)" },
      { name: "public", type: "boolean", description: "Create the row PUBLISHED (isPublic=1, readable cross-tenant). Omit for private — the default; requires company-admin rights" },
      { name: "geocode", type: "boolean", description: "Resolve lat/lng from the address via Google Maps when coordinates are not given (then persisted + echoed)" },
    ],
    writeFlags: true,
    dryRunKind: "server",
    outputShape: "{ sijaintiId, success, lat?, lng?, coordsPersisted? } — lat/lng/coordsPersisted present when coordinates were given (coordsPersisted:false on --dry-run)",
    errors: [
      apiErr(400, "Validation failed", "fix --body fields"),
      // CLIENT-side, not a backend 400 (fb#668 follow-up). `--geocode` is
      // resolved entirely in the CLI: applyGeocodeToBody geocodes FIRST and
      // `failWith(..., 4)`s on no match, so the POST never happens and no 400
      // ever arrives. Verified live — the real error is
      // `could not geocode address "..." (status: ZERO_RESULTS|NO_ROUTE_FOUND)`
      // with statusCode 0. (The ordinary address-change geocode is separate and
      // SOFT-fails, reporting `geocodeFailed` on a SUCCESSFUL response.)
      GEOCODE_CLIENT_ERR,
      GEOCODE_NO_ADDRESS_ERR,
      // Required-field guard, previously undocumented — and while the puomi row
      // below was the command's only matchless client row, matchClientRow's
      // sole-row fallback answered THIS failure with the puomi remedy.
      { origin: "client", exit: 4, match: "create requires:", meaning: "A required field is missing (the message names which)", remedy: "pass the flags the message names — --name and --type are the two the guard requires" },
      // `match` added so the row stops acting as this command's catch-all
      // (fb#668 follow-up); its `sijainti update` twin already had one.
      puomiErr(),
      ...permErrors("auth.page.sijainnit.edit"),
    ],
    notes: [
      "A new sijainti is created PRIVATE unless you pass --public. That is deliberate — no caller should be able to publish a location by omission — but for a BETONIASEMA (--type 1) it is rarely what you want: a private plant never appears in any customer's tehdas picker, and the keikka editor then auto-selects a farther plant and reports success. Nothing errors. Pass --public when creating a plant customers must be able to choose, or publish it afterwards with `ib sijainti set-public <id> --on`.",
      "--public requires company-admin rights (or sysadmin/developer) and is refused with 403 on --dry-run too; every other field on create is open to the edit tier. Creating the row private and having an admin publish it is the workaround.",
      "Before 2026-08-14 visibility was a property of the location TYPE, so `--type 1` alone produced a publicly visible plant. It no longer does — the flag is per row.",
    ],
    examples: [
      'ib sijainti create --name "Depot A" --type 5',
      'ib sijainti create --name "Kivikko" --type 1 --public --reason "plant customers must be able to pick"',
      'ib sijainti create --name "Depot A" --address "Industrial St 1, Helsinki" --type 1 --geocode',
      'ib sijainti create --name "Depot A" --address "Industrial St 1" --type 1 --lat 60.17 --lng 24.94 --lyh "DEP-A" --max-distance 80',
      "ib sijainti create --body '{\"sijaintiNimi\":\"Depot A\",\"sijaintiTypeId\":1}'",
    ],
  },
  {
    command: "ib sijainti update",
    description:
      "Update a sijainti via read-merge-write (GET current row + POST /api/geocode/updateSijainti). sijaintiId via --id or in --body. Omitted fields KEEP their current values (the save proc assigns directly — a sparse body would NULL e.g. jerryActiveUntil, dates, phone); pass an explicit null in --body to clear a field. --max-distance is the general delivery radius in km (stored as maxDeliveryDistance), independent of BetoniJerry enrolment. An address change re-geocodes the new address automatically when no --lat/--lng are given (soft-fail: geocodeFailed echoed; --geocode forces re-resolution and fails fast). --lat/--lng are persisted via a follow-up updateLatLng call (the save proc itself binds no lat/lng) and echoed as { lat, lng, coordsPersisted }. Provide typed flags or --body JSON; typed flags win over --body.",
    permissions: ["auth.page.sijainnit.edit"],
    flags: [
      // NB: unlike `person update` / `worksite update`, this command has NO
      // --from-json, so the PowerShell escape hatch here is typed flags only.
      { name: "body", type: "json", description: "JSON object with fields to update (optional if typed flags given) ⚠ Windows PowerShell splits this argument on its inner double-quotes, so inline JSON arrives mangled and exits 4 as a too-many-arguments usage error — use the typed flags there (this command has no --from-json; see `ib help shell-quoting`)." },
      { name: "id", type: "number", description: "Target sijaintiId (or include sijaintiId in --body)" },
      { name: "name", type: "string", description: "sijaintiNimi" },
      { name: "address", type: "string", description: "sijaintiOsoite1 (street)" },
      { name: "type", type: "number", description: "sijaintiTypeId" },
      { name: "lat", type: "number", description: "Latitude (persisted via updateLatLng + echoed)" },
      { name: "lng", type: "number", description: "Longitude (persisted via updateLatLng + echoed)" },
      { name: "lyh", type: "string", description: "sijaintiLyh — short code/abbreviation (≤50 chars)" },
      { name: "max-distance", type: "number", description: "Delivery radius in km, stored as maxDeliveryDistance (not Jerry-only)" },
      { name: "puomi-min", type: "number", description: "puomiMin (m) — STORED ONLY, not used for matching (fb#415): no pump has a boom minimum, so a floor could only hide you from work you can do" },
      { name: "puomi-max", type: "number", description: "puomiMax — largest boom (m) served from this sijainti (BetoniJerry matching; empty = unbounded)" },
      { name: "public", type: "boolean", description: "Publish (isPublic=1, readable cross-tenant). Requires company-admin rights; omit BOTH flags to leave visibility untouched" },
      { name: "private", type: "boolean", description: "Unpublish (isPublic=0, owning tenant only). Mutually exclusive with --public; see `ib sijainti set-public`" },
      { name: "geocode", type: "boolean", description: "Force re-resolving lat/lng from the address via Google Maps (fails fast on no match). Address changes auto-geocode even without this flag when no coordinates are given" },
    ],
    writeFlags: true,
    dryRunKind: "server",
    outputShape: "{ ok: true, ..., lat?, lng?, coordsPersisted?, geocodeFailed? } — lat/lng/coordsPersisted present when coordinates were supplied or geocoded; geocodeFailed when the automatic address-change geocode found no match (update still ran, coords now NULL)",
    errors: [
      apiErr(400, "Validation failed", "fix --body fields"),
      // Client-side — see the twin on `sijainti create` (fb#668 follow-up).
      GEOCODE_CLIENT_ERR,
      GEOCODE_NO_ADDRESS_ERR,
      apiErr(404, "Sijainti not found", "verify sijaintiId"),
      puomiErr(" — would otherwise clear the stored bound"),
      { origin: "client", exit: 4, match: "at most one of --public", meaning: "Both --public and --private given", remedy: "pass at most one — omit both to leave visibility untouched" },
      // Previously undocumented, so it fell through to no hint at all.
      // `--body` only: this command does NOT register --from-json (person/worksite
      // update do). Naming it here would send the caller to an unknown-option
      // exit 4 — the guard's own message names only --body, and so does this.
      { origin: "client", exit: 4, match: "update requires sijaintiid", meaning: "No sijaintiId given (neither --id nor a sijaintiId in --body)", remedy: "pass --id <sijaintiId>, or include sijaintiId in --body" },
      apiErr(403, "Not a company admin — only admins may CHANGE isPublic", "drop --public/--private to edit the other fields, or ask a company admin; see `ib sijainti set-public`", SIJAINTI_PUBLIC_403_MATCH),
      ...permErrors("auth.page.sijainnit.edit"),
    ],
    examples: [
      'ib sijainti update --id 42 --name "Renamed depot"',
      'ib sijainti update --id 42 --address "Teollisuuskatu 9, Helsinki" --geocode',
      "ib sijainti update --body '{\"sijaintiId\":42,\"sijaintiNimi\":\"Renamed depot\"}'",
      "ib sijainti update --id 42 --public --reason 'open this plant to customers'",
    ],
  },
  {
    command: "ib sijainti set-jerry",
    description: "Enrol or unenrol a varikko (location) in BetoniJerry by setting sijainti.jerryActiveUntil (POST /api/geocode/updateSijainti).",
    permissions: ["auth.page.sijainnit.edit"],
    args: [{ name: "sijaintiId", type: "number", description: "sijaintiId to toggle" }],
    flags: [
      { name: "on", type: "boolean", description: "Enrol (jerryActiveUntil = sentinel) + ensure a delivery radius" },
      { name: "off", type: "boolean", description: "Unenrol (jerryActiveUntil = null)" },
      { name: "radius", type: "number", description: "Delivery radius in km (maxDeliveryDistance) to set when enrolling; defaults to 50 when the varikko has none" },
      { name: "puomi-min", type: "number", description: "puomiMin (m) to set while enrolling — STORED ONLY, not used for matching (fb#415); betonijerry matches on puomiMax alone" },
      { name: "puomi-max", type: "number", description: "puomiMax (m) to set while enrolling" },
    ],
    writeFlags: true,
    dryRunKind: "server",
    outputShape:
      "{ ok: true, ... } (raw backend response) or { dryRun: true, wouldUpdate: {...} }",
    errors: [
      // Both guards are CLIENT-side `failWith(..., 4)` in the action, not a
      // backend 400 (fb#668 follow-up) — the request is never sent.
      { origin: "client", exit: 4, match: ["pass exactly one of --on", "--radius must be a positive"], meaning: "Neither/both of --on/--off given, or --radius not a positive number", remedy: "pass exactly one of --on / --off; --radius is km > 0" },
      // `match` added so this narrow row stops answering every client failure on
      // the command (fb#668 follow-up).
      puomiErr(),
      apiErr(404, "Sijainti not found", "verify sijaintiId"),
      ...permErrors("auth.page.sijainnit.edit"),
    ],
    notes: [
      "--on writes the permanent sentinel; --off clears it to null.",
      "IMPORTANT: BetoniJerry coverage keys on the delivery radius maxDeliveryDistance (KM) — NOT geofenceRadius (metres, a GPS depot detector) — so --on ALSO sets that radius: --radius <km>, or a 50 km default when the varikko has none (otherwise it would be enrolled but cover nothing).",
      "Replicates the EditSijainti toggle: reads the row, overrides the fields, and writes back (lat/lng etc. preserved).",
      "Matching also requires the company-level gates: isPumppuToimittaja AND the HAS_JERRY setting (asiakasSettingTypeId 35) — toggle both with `ib jerry admin enable`. Varikko enrolment alone does not make the company matchable.",
      "Boom matching (since 2026-07, corrected 2026-08-12): a request stating a boom matches a varikko when its REACH covers it — puomiMax IS NULL (unbounded) OR puomiMax >= boom. `puomiMin` is stored but NOT matched on: any pump can be run as a line pump with no boom, so a floor could only hide a provider from work it can do (fb#415). Vehicle fleet booms are NOT consulted. Deploy-gated: needs the backend with sijainti puomi columns.",
    ],
    examples: [
      "ib sijainti set-jerry 42 --on --radius 60 --reason 'pilot varikko, 60 km radius'",
      "ib sijainti set-jerry 42 --on --reason 'enrol with default 50 km radius'",
      "ib sijainti set-jerry 42 --off --reason 'seasonal pause'",
    ],
  },
  {
    command: "ib sijainti set-public",
    description:
      "Publish or unpublish a sijainti — set dbo.sijainti.isPublic (POST /api/geocode/updateSijainti). Publishing makes the row readable CROSS-TENANT by every authenticated user, which is how the keikka flow finds a supplier's concrete plants.",
    permissions: ["auth.page.sijainnit.edit", "company admin (to change isPublic)"],
    args: [{ name: "sijaintiId", type: "number", description: "sijaintiId to publish/unpublish" }],
    flags: [
      { name: "on", type: "boolean", description: "Publish (isPublic = 1) — readable by every tenant" },
      { name: "off", type: "boolean", description: "Unpublish (isPublic = 0) — owning tenant only" },
    ],
    writeFlags: true,
    dryRunKind: "server",
    outputShape:
      "{ ok: true, ... } (raw backend response) or { dryRun: true, wouldUpdate: {...} }",
    errors: [
      { origin: "client", exit: 4, meaning: "Neither or both of --on/--off given", remedy: "pass exactly one — visibility is never inferred" },
      apiErr(403, "Not a company admin — only admins may change visibility", "the edit tier can change every other field; ask a company admin (or a developer) to flip this one", SIJAINTI_PUBLIC_403_MATCH),
      apiErr(404, "Sijainti not found", "verify sijaintiId"),
      ...permErrors("auth.page.sijainnit.edit"),
    ],
    notes: [
      "isPublic = 1 means readable by every authenticated user of EVERY tenant, competitors included — it is a cross-tenant exposure control, not a display preference. `ib sijainti get` on a published row succeeds for any caller; on a private row it 403s unless you are entitled to the owner.",
      "PER-ROW since 2026-08-14. It used to live on the location TYPE, so a supplier's plants were all readable or none were; now a decommissioned or contract-only plant can be withheld while the rest stay listed.",
      "The 403 applies to --dry-run too: an authorization refusal must not be reported as a successful preview. Changing OTHER fields is unaffected — the gate is on this field, not on the route.",
      "Replicates the EditSijainti save: reads the row, overrides isPublic, writes back, so jerryActiveUntil / dates / phone / comment survive. Going through updateSijainti is also required for CACHE correctness — that route's invalidation sweep is what stops a list cached while the row was public from being served after it is made private.",
      "Unpublishing a concrete plant removes it from every customer's tehdas picker. That is silent by design on their side: the keikka editor simply auto-selects a different plant. Audit with `ib sijainti list --type betoniasema --all --private`.",
      "Flips are recorded to changeTracker as \"Julkinen sijainti\" (who/when/old→new), so --reason is worth passing even though it is not enforced.",
    ],
    seeAlso: ["ib sijainti list", "ib sijainti get", "ib sijainti update", "ib sijainti set-jerry"],
    examples: [
      "ib sijainti set-public 42 --on --reason 'plant open to customers'",
      "ib sijainti set-public 42 --off --reason 'decommissioned, hide from pickers'",
      "ib sijainti set-public 42 --on --dry-run",
    ],
  },
  {
    command: "ib sijainti delete",
    description:
      "Soft-delete a sijainti (sets deletedTime). Requires --reason; --dry-run available.",
    permissions: ["auth.page.sijainnit.delete"],
    args: [{ name: "sijaintiId", type: "number", description: "sijaintiId to soft-delete" }],
    flags: [
      REASON_REQUIRED_FLAG,
    ],
    writeFlags: true,
    dryRunKind: "server",
    reasonPolicy: "always",
    outputShape: "{ success: true }",
    errors: [
      apiErr(404, "Sijainti not found", "verify sijaintiId"),
      ...permErrors("auth.page.sijainnit.delete"),
    ],
    examples: ['ib sijainti delete 42 --reason "decommissioned depot"'],
  },
  {
    command: "ib sijainti undelete",
    description: "Restore a soft-deleted sijainti. Requires --reason.",
    permissions: ["auth.page.sijainnit.edit"],
    args: [{ name: "sijaintiId", type: "number", description: "sijaintiId to restore" }],
    flags: [
      REASON_REQUIRED_FLAG,
    ],
    writeFlags: true,
    dryRunKind: "server",
    reasonPolicy: "always",
    outputShape: "{ success: true }",
    errors: [
      apiErr(404, "Sijainti not found", "verify sijaintiId"),
      ...permErrors("auth.page.sijainnit.edit"),
    ],
    examples: ['ib sijainti undelete 42 --reason "restored after review"'],
  },
  {
    command: "ib sijainti types",
    description:
      "List sijainti type categories (the 'Sijainnin laji' lookup). Resolves the sijaintiTypeId values used by `sijainti list --type` (which also accepts these names, e.g. betoniasema) and `create/update --type`.",
    permissions: ["auth.page.sijainnit.read"],
    flags: [
      { name: "jerry", type: "boolean", description: "Return ONLY the BetoniJerry-eligible types (useJerry=1). Since fb#608 every row carries `useJerry`, so the unfiltered call already answers which types are eligible — this flag is now a convenience, not the only way to find out." },
    ],
    outputShape: "ListEnvelope<{ sijaintiTypeId, selite, useJerry }> — `useJerry` is the column --jerry filters on (fb#608); before it was surfaced, learning the eligible set meant running the command twice and diffing the id sets. NOTE: publicity is deliberately NOT part of this output — cross-tenant visibility is per ROW (dbo.sijainti.isPublic), not per type; the old type-level sijaintitypes.isPublic was dropped 2026-08-26 (fb#640), so a type-level flag cannot answer 'is this location public'.",
    errors: permErrors("auth.page.sijainnit.read"),
    examples: ["ib sijainti types", "ib sijainti types --jerry"],
  },
  {
    command: "ib sijainti geocode",
    description:
      "Geocode a free-form address to coordinates via Google Maps. Useful before `sijainti create` to obtain lat/lng. ownerAsiakasId is derived from the token.",
    permissions: ["auth.page.sijainnit.read"],
    flags: [
      { name: "address", type: "string", description: "Free-form address (REQUIRED)" },
    ],
    outputShape:
      "{ geocoded:boolean, lat|null, lng|null, placeId|null, formattedAddress|null, status, results[] }",
    errors: permErrors("auth.page.sijainnit.read"),
    notes: [
      "The flat fields are the SAME shape `ib jerry check-address` returns (geocoded/lat/lng/placeId/formattedAddress), so one parser reads both. The raw Google payload is retained as `results[]` for callers that need address_components, viewport, or location_type.",
      "No match is `geocoded:false` with exit 0, not an error — the address not existing is an answer. Always read `status` alongside it: ZERO_RESULTS means Google found nothing (or the address was shorter than 5 characters), while TEST_ADDRESS / GOOGLE_MAPS_TIMEOUT / GOOGLE_MAPS_API_ERROR mean the lookup never happened. Treating a bare geocoded:false as 'no such address' hides a service failure.",
    ],
    seeAlso: ["ib jerry check-address"],
    examples: ['ib sijainti geocode --address "Mannerheimintie 1, Helsinki"'],
  },
  {
    command: "ib sijainti closest",
    description:
      "Find the closest sijainti of a given sijaintiTypeId to a worksite (tyomaa), by straight-line distance. asiakasId defaults to the active company.",
    permissions: ["auth.page.sijainnit.read"],
    flags: [
      { name: "worksite", type: "number", description: "Target tyomaaId (REQUIRED unless --tyomaa; same flag as the rest of the CLI)" },
      { name: "tyomaa", type: "number", description: "Target tyomaaId (Finnish alias of --worksite)" },
      { name: "type", type: "number", description: "sijaintiTypeId to search within (REQUIRED)" },
      { name: "asiakas", type: "number", description: "Owner asiakasId (defaults to active company)" },
    ],
    outputShape: "{ closestSijainti: {...}|null, closestDistance: number|null }",
    errors: [
      {
        origin: "client",
        exit: 4,
        meaning:
          "No worksite given, --worksite and --tyomaa differ, or one of --worksite/--tyomaa/--type/--asiakas is not a positive integer",
        remedy: "name the worksite once (--worksite OR --tyomaa) and pass integer ids",
      },
      apiErr(400, "Invalid tyomaaId or missing coordinates", "verify the worksite has lat/lng"),
      ...permErrors("auth.page.sijainnit.read"),
    ],
    notes: [
      "No sijainti of the type → both fields null (the backend's 999999999 no-result sentinel distance is normalized to null).",
    ],
    examples: ["ib sijainti closest --worksite 555 --type 1", "ib sijainti closest --tyomaa 555 --type 1"],
  },
  {
    command: "ib sijainti distance",
    description:
      "Driving distance and time between two points (Google Maps). Each endpoint is either 'lat,lng' or a sijaintiId (resolved to its coordinates). ownerAsiakasId is derived from the active company.",
    permissions: ["auth.page.sijainnit.read"],
    flags: [
      { name: "from", type: "string", description: "Origin: 'lat,lng' or a sijaintiId (REQUIRED)" },
      { name: "to", type: "string", description: "Destination: 'lat,lng' or a sijaintiId (REQUIRED)" },
    ],
    outputShape: "{ matkaM: number|null, matkaMin: number|null, from:{lat,lng}, to:{lat,lng} }",
    errors: [
      apiErr(400, "Bad point or sijainti without coordinates", "use 'lat,lng' or a sijaintiId that has coords"),
      ...permErrors("auth.page.sijainnit.read"),
    ],
    examples: [
      "ib sijainti distance --from 7 --to 42",
      'ib sijainti distance --from "60.17,24.94" --to 42',
    ],
  },
];
