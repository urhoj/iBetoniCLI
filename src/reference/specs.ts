/**
 * Catalogue of every `ib` subcommand for v1.0.
 *
 * Each entry is a {@link CommandSpec} consumed by:
 *  - `src/output/help.ts`  → renders `--help` for the matching subcommand;
 *  - `src/reference/dump.ts` → emits the entire surface as JSON via
 *    `ib reference dump`, the single document an AI assistant ingests to
 *    learn the CLI in one shot.
 *
 * Keeping the catalogue in one file means human help and the machine
 * reference share a single source of truth — there is no separate doc to
 * drift. Errors codes follow the universal exit-code map:
 *   401 = token expired (remedy: `ib auth refresh`)
 *   403 = permission denied (remedy: check the listed `auth.page.*`)
 *   404 = not found
 *   400 = validation
 *   500 = backend error
 */
import type { CommandSpec } from "../output/help.js";

/** Errors that apply to every authenticated command. */
const COMMON_AUTH_ERRORS = [
  { code: 401, meaning: "Token expired", remedy: "ib auth refresh" },
  { code: 500, meaning: "Backend error", remedy: "retry with --verbose" },
] as const;

/** Errors that apply to every authenticated command with permission gating. */
function permErrors(page: string) {
  return [
    { code: 401, meaning: "Token expired", remedy: "ib auth refresh" },
    {
      code: 403,
      meaning: "Permission denied",
      remedy: `check ${page}`,
    },
    { code: 500, meaning: "Backend error", remedy: "retry with --verbose" },
  ];
}

export const COMMAND_SPECS: CommandSpec[] = [
  // ─── auth (5) ────────────────────────────────────────────────────────────
  {
    command: "ib auth login",
    description:
      "Open the system browser to authorize this CLI via OAuth 2.1 + PKCE and persist credentials to ~/.ibetoni/credentials.json (mode 0600).",
    flags: [
      {
        name: "endpoint",
        type: "url",
        default: "https://api.ibetoni.fi",
        description: "API endpoint to authorize against",
      },
    ],
    outputShape:
      "stderr: 'Logged in as <email> at <company>.'; credentials file written",
    errors: [
      {
        code: 2,
        meaning: "OAuth flow failed",
        remedy: "retry; check network / browser",
      },
      { code: 500, meaning: "Backend error", remedy: "retry later" },
    ],
    examples: [
      "ib auth login",
      "ib auth login --endpoint https://api-staging.ibetoni.fi",
    ],
  },
  {
    command: "ib auth logout",
    description:
      "Revoke the refresh token server-side (best-effort) and delete the local credentials file.",
    flags: [],
    outputShape: "no stdout output; exit 0 on success",
    errors: [
      { code: 1, meaning: "I/O error", remedy: "check file permissions" },
    ],
    examples: ["ib auth logout"],
  },
  {
    command: "ib auth whoami",
    description:
      "Print the current authenticated user's personId, active company, and endpoint.",
    flags: [],
    outputShape:
      "{ personId, activeCompany: { asiakasId, name }, endpoint }",
    errors: [
      {
        code: 2,
        meaning: "Not logged in",
        remedy: "ib auth login first",
      },
    ],
    examples: ["ib auth whoami"],
  },
  {
    command: "ib auth switch",
    description:
      "Switch the active company. Issues a new JWT bound to the target ownerAsiakasId and persists it.",
    flags: [
      {
        name: "to",
        type: "number",
        description: "Target asiakasId to switch to",
      },
    ],
    outputShape: "{ ok: true, activeCompany: { asiakasId, name } }",
    errors: [
      { code: 2, meaning: "Not logged in", remedy: "ib auth login" },
      {
        code: 403,
        meaning: "No access to target",
        remedy: "verify ownership via `ib company list`",
      },
    ],
    examples: ["ib auth switch --to 1349"],
  },
  {
    command: "ib auth refresh",
    description:
      "Manually refresh the JWT against /api/auth/refresh-token. Automatic refresh-on-401 also happens in the API client.",
    flags: [],
    outputShape: "{ ok: true }",
    errors: [
      {
        code: 2,
        meaning: "Refresh failed",
        remedy: "ib auth login to re-authenticate",
      },
    ],
    examples: ["ib auth refresh"],
  },

  // ─── company (3) ─────────────────────────────────────────────────────────
  {
    command: "ib company list",
    description:
      "List the companies the current user can act on, with the active one marked `current: true`.",
    flags: [],
    outputShape:
      "ListEnvelope<{ asiakasId, name, current }> = { items, nextCursor, count }",
    errors: [...COMMON_AUTH_ERRORS],
    examples: ["ib company list", "ib company list --pretty"],
  },
  {
    command: "ib company current",
    description:
      "Return the record of the active company (the one bound to the current JWT).",
    flags: [],
    outputShape: "{ asiakasId, name }",
    errors: [...COMMON_AUTH_ERRORS],
    examples: ["ib company current"],
  },
  {
    command: "ib company switch",
    description:
      "Switch the active company. Alias of `ib auth switch`. Persists the rotated JWT.",
    flags: [
      {
        name: "to",
        type: "number",
        description: "Target asiakasId to switch to",
      },
    ],
    outputShape: "{ ok: true, activeCompany: { asiakasId, name } }",
    errors: [
      {
        code: 403,
        meaning: "No access to target",
        remedy: "verify via `ib company list`",
      },
      ...COMMON_AUTH_ERRORS,
    ],
    examples: ["ib company switch --to 1349"],
  },

  // ─── keikka (5) ──────────────────────────────────────────────────────────
  {
    command: "ib keikka list",
    description:
      "List concrete delivery orders (keikkas) for the active company within a date range. Flat envelope optimised for AI/CI consumption.",
    permissions: ["auth.page.grid.tilaus.read"],
    flags: [
      {
        name: "from",
        type: "date",
        default: "today",
        description: "Start date (YYYY-MM-DD or today/yesterday/tomorrow)",
      },
      {
        name: "to",
        type: "date",
        default: "today",
        description: "End date (YYYY-MM-DD or today/yesterday/tomorrow)",
      },
      {
        name: "customer",
        type: "number",
        description: "Filter by asiakasId",
      },
      {
        name: "vehicle",
        type: "number",
        description: "Filter by vehicleId",
      },
      { name: "status", type: "string", description: "Filter by tila/status" },
      {
        name: "limit",
        type: "number",
        default: "100",
        description: "Max rows (server caps at 500)",
      },
      { name: "cursor", type: "string", description: "Pagination cursor" },
    ],
    outputShape:
      "ListEnvelope<{ keikkaId, pvm, asiakasId, tyomaaId, vehicleId, tila, m3, time }>",
    errors: permErrors("auth.page.grid.tilaus.read"),
    examples: [
      "ib keikka list --from 2026-05-28 --to 2026-05-30",
      "ib keikka list --customer 1349 --status planned --limit 50",
      "ib keikka list --from today --to tomorrow --pretty",
    ],
  },
  {
    command: "ib keikka get",
    description:
      "Get a single keikka by id with related customer / worksite / vehicle / driver projections.",
    permissions: ["auth.page.grid.tilaus.read"],
    flags: [
      {
        name: "keikkaId",
        type: "number",
        description: "Positional argument — the keikkaId to fetch",
      },
    ],
    outputShape:
      "{ keikkaId, pvm, time, customer:{asiakasId,name}, worksite:{tyomaaId,address}, vehicle:{vehicleId,plate}, driver:{personId,name}, m3, status }",
    errors: [
      { code: 404, meaning: "Keikka not found", remedy: "verify keikkaId" },
      ...permErrors("auth.page.grid.tilaus.read"),
    ],
    examples: ["ib keikka get 9001"],
  },
  {
    command: "ib keikka create",
    description:
      "Create a new keikka. The body is forwarded verbatim to POST /api/keikka/newKeikka — see the backend route for required fields.",
    permissions: ["auth.page.grid.tilaus.edit"],
    flags: [
      {
        name: "body",
        type: "json",
        description: "JSON object with the new keikka fields",
      },
    ],
    writeFlags: true,
    outputShape: "{ keikkaId, ...echoed fields } (raw backend response)",
    errors: [
      { code: 400, meaning: "Validation failed", remedy: "fix --body fields" },
      ...permErrors("auth.page.grid.tilaus.edit"),
    ],
    examples: [
      "ib keikka create --body '{\"asiakasId\":1349,\"pvm\":\"2026-06-01\"}' --reason 'manual booking'",
      "ib keikka create --body '{...}' --dry-run",
    ],
  },
  {
    command: "ib keikka update",
    description:
      "Update a keikka. v1.0 supports only `--status` (forwarded as `tila` to POST /api/keikka/setStatus). Other field-setters land in v1.1.",
    permissions: ["auth.page.grid.tilaus.edit"],
    flags: [
      {
        name: "keikkaId",
        type: "number",
        description: "Positional — keikkaId to update",
      },
      {
        name: "status",
        type: "string",
        description: "New tila/status value",
      },
    ],
    writeFlags: true,
    outputShape: "{ ok: true } or backend response",
    errors: [
      { code: 400, meaning: "Validation failed", remedy: "check --status" },
      { code: 404, meaning: "Keikka not found", remedy: "verify keikkaId" },
      ...permErrors("auth.page.grid.tilaus.edit"),
    ],
    examples: [
      "ib keikka update 9001 --status done",
      "ib keikka update 9001 --status confirmed --reason 'phone confirmation'",
    ],
  },
  {
    command: "ib keikka drivers assign",
    description:
      "Assign the default driver to a keikka. POST /api/keikka/defaultDriver/assign/:keikkaId; driver is selected by the backend from JWT/keikka context.",
    permissions: ["auth.page.grid.tilaus.edit"],
    flags: [
      {
        name: "keikkaId",
        type: "number",
        description: "Positional — keikkaId to assign default driver to",
      },
    ],
    writeFlags: true,
    outputShape: "{ ok: true, driver:{personId,name} } (raw backend response)",
    errors: [
      { code: 404, meaning: "Keikka not found", remedy: "verify keikkaId" },
      ...permErrors("auth.page.grid.tilaus.edit"),
    ],
    examples: [
      "ib keikka drivers assign 9001",
      "ib keikka drivers assign 9001 --dry-run",
    ],
  },

  // ─── customer (5) ────────────────────────────────────────────────────────
  {
    command: "ib customer list",
    description:
      "List customers (asiakkaat) visible to the active company. ownerAsiakasId derived from JWT.",
    permissions: ["auth.page.asiakas.read"],
    flags: [
      {
        name: "limit",
        type: "number",
        default: "100",
        description: "Max rows (capped at 500)",
      },
      { name: "cursor", type: "string", description: "Pagination cursor" },
    ],
    outputShape:
      "ListEnvelope<{ asiakasId, name, yTunnus, type }>",
    errors: permErrors("auth.page.asiakas.read"),
    examples: ["ib customer list", "ib customer list --limit 50 --pretty"],
  },
  {
    command: "ib customer get",
    description:
      "Get a single customer (asiakas) by id with flat contact fields.",
    permissions: ["auth.page.asiakas.read"],
    flags: [
      {
        name: "asiakasId",
        type: "number",
        description: "Positional — asiakasId to fetch",
      },
    ],
    outputShape:
      "{ asiakasId, name, yTunnus, type, address, city, email, phone }",
    errors: [
      { code: 404, meaning: "Customer not found", remedy: "verify asiakasId" },
      ...permErrors("auth.page.asiakas.read"),
    ],
    examples: ["ib customer get 1349"],
  },
  {
    command: "ib customer create",
    description:
      "Create a new customer via POST /api/asiakas/createY. Body forwarded verbatim.",
    permissions: ["auth.page.asiakas.edit"],
    flags: [
      {
        name: "body",
        type: "json",
        description: "JSON object with the new customer fields",
      },
    ],
    writeFlags: true,
    outputShape: "{ asiakasId, ... } (raw backend response)",
    errors: [
      { code: 400, meaning: "Validation failed", remedy: "fix --body fields" },
      ...permErrors("auth.page.asiakas.edit"),
    ],
    examples: [
      "ib customer create --body '{\"name\":\"Example Oy\",\"yTunnus\":\"1234567-8\"}' --idempotency-key new-example-oy",
    ],
  },
  {
    command: "ib customer update",
    description:
      "Update a customer via POST /api/asiakas/set/:asiakasId. Body forwarded verbatim.",
    permissions: ["auth.page.asiakas.edit"],
    flags: [
      {
        name: "asiakasId",
        type: "number",
        description: "Positional — asiakasId to update",
      },
      {
        name: "body",
        type: "json",
        description: "JSON object with the fields to update",
      },
    ],
    writeFlags: true,
    outputShape: "{ ok: true, ... } (raw backend response)",
    errors: [
      { code: 400, meaning: "Validation failed", remedy: "fix --body fields" },
      { code: 404, meaning: "Customer not found", remedy: "verify asiakasId" },
      ...permErrors("auth.page.asiakas.edit"),
    ],
    examples: [
      "ib customer update 1349 --body '{\"email\":\"new@example.com\"}' --reason 'customer requested'",
    ],
  },
  {
    command: "ib customer search",
    description:
      "Free-text search across customer names / yTunnus / contacts. GET /api/asiakas/search?q=...",
    permissions: ["auth.page.asiakas.read"],
    flags: [
      {
        name: "query",
        type: "string",
        description: "Positional — search string",
      },
      {
        name: "limit",
        type: "number",
        default: "50",
        description: "Max results",
      },
    ],
    outputShape:
      "ListEnvelope<{ asiakasId, name, yTunnus, score }>",
    errors: permErrors("auth.page.asiakas.read"),
    examples: ["ib customer search Example", "ib customer search 1234567"],
  },

  // ─── worksite (5) ────────────────────────────────────────────────────────
  {
    command: "ib worksite list",
    description:
      "List worksites (tyomaat) visible to the active company. ownerAsiakasId derived from JWT.",
    permissions: ["auth.page.tyomaa.read"],
    flags: [
      {
        name: "customer",
        type: "number",
        description: "Filter by parent asiakasId",
      },
      {
        name: "limit",
        type: "number",
        default: "100",
        description: "Max rows (capped at 500)",
      },
      { name: "cursor", type: "string", description: "Pagination cursor" },
    ],
    outputShape:
      "ListEnvelope<{ tyomaaId, name, address, asiakasId, city }>",
    errors: permErrors("auth.page.tyomaa.read"),
    examples: ["ib worksite list", "ib worksite list --customer 1349"],
  },
  {
    command: "ib worksite get",
    description:
      "Get a single worksite (tyomaa) by id with flat address fields.",
    permissions: ["auth.page.tyomaa.read"],
    flags: [
      {
        name: "tyomaaId",
        type: "number",
        description: "Positional — tyomaaId to fetch",
      },
    ],
    outputShape:
      "{ tyomaaId, name, address, asiakasId, city, comment, coords:{lat,lng} }",
    errors: [
      { code: 404, meaning: "Worksite not found", remedy: "verify tyomaaId" },
      ...permErrors("auth.page.tyomaa.read"),
    ],
    examples: ["ib worksite get 99"],
  },
  {
    command: "ib worksite create",
    description:
      "Create a new worksite via POST /api/tyomaa/new. Body forwarded verbatim.",
    permissions: ["auth.page.tyomaa.edit"],
    flags: [
      {
        name: "body",
        type: "json",
        description: "JSON object with the new tyomaa fields",
      },
    ],
    writeFlags: true,
    outputShape: "{ tyomaaId, ... } (raw backend response)",
    errors: [
      { code: 400, meaning: "Validation failed", remedy: "fix --body fields" },
      ...permErrors("auth.page.tyomaa.edit"),
    ],
    examples: [
      "ib worksite create --body '{\"name\":\"Site A\",\"address\":\"Main St 1\",\"asiakasId\":1349}'",
    ],
  },
  {
    command: "ib worksite update",
    description:
      "Update a worksite via POST /api/tyomaa/set/:ownerAsiakasId/:tyomaaId/:yyyymmdd.",
    permissions: ["auth.page.tyomaa.edit"],
    flags: [
      {
        name: "tyomaaId",
        type: "number",
        description: "Positional — tyomaaId to update",
      },
      {
        name: "body",
        type: "json",
        description: "JSON object with the fields to update",
      },
      {
        name: "date",
        type: "date",
        default: "today",
        description: "Effective date (YYYYMMDD; today by default)",
      },
    ],
    writeFlags: true,
    outputShape: "{ ok: true, ... } (raw backend response)",
    errors: [
      { code: 400, meaning: "Validation failed", remedy: "fix --body fields" },
      { code: 404, meaning: "Worksite not found", remedy: "verify tyomaaId" },
      ...permErrors("auth.page.tyomaa.edit"),
    ],
    examples: [
      "ib worksite update 99 --body '{\"comment\":\"Pickup at gate B\"}'",
    ],
  },
  {
    command: "ib worksite search",
    description:
      "Free-text search across worksite names / addresses. POST /api/tyomaa/search.",
    permissions: ["auth.page.tyomaa.read"],
    flags: [
      {
        name: "query",
        type: "string",
        description: "Positional — search string",
      },
      {
        name: "limit",
        type: "number",
        default: "50",
        description: "Max results",
      },
    ],
    outputShape:
      "ListEnvelope<{ tyomaaId, name, address, asiakasId, score }>",
    errors: permErrors("auth.page.tyomaa.read"),
    examples: ["ib worksite search 'Main St'"],
  },

  // ─── person (3) ──────────────────────────────────────────────────────────
  {
    command: "ib person list",
    description:
      "List persons (drivers, admins, etc.) visible to the active company. Optional --role uses ROLE_NAME_BY_TYPEID from @ibetoni/constants.",
    permissions: ["auth.page.person.read"],
    flags: [
      {
        name: "role",
        type: "string",
        description: "Filter by role name (e.g. driver, admin, laskuAdmin)",
      },
      {
        name: "asiakas",
        type: "number",
        description: "Filter by asiakasId membership",
      },
      {
        name: "limit",
        type: "number",
        default: "100",
        description: "Max rows (capped at 500)",
      },
    ],
    outputShape:
      "ListEnvelope<{ personId, name, email, roles:number[] }>",
    errors: [
      {
        code: 400,
        meaning: "Unknown role",
        remedy: "use a role from @ibetoni/constants ROLE_TYPEID_BY_NAME",
      },
      ...permErrors("auth.page.person.read"),
    ],
    examples: [
      "ib person list --role driver",
      "ib person list --asiakas 1349 --limit 50",
    ],
  },
  {
    command: "ib person get",
    description: "Get a single person by personId.",
    permissions: ["auth.page.person.read"],
    flags: [
      {
        name: "personId",
        type: "number",
        description: "Positional — personId to fetch",
      },
    ],
    outputShape:
      "{ personId, name, email, phone, roles:number[] }",
    errors: [
      { code: 404, meaning: "Person not found", remedy: "verify personId" },
      ...permErrors("auth.page.person.read"),
    ],
    examples: ["ib person get 6233"],
  },
  {
    command: "ib person search",
    description:
      "Free-text search across person names / emails. POST /api/person/search.",
    permissions: ["auth.page.person.read"],
    flags: [
      {
        name: "query",
        type: "string",
        description: "Positional — search string",
      },
      {
        name: "limit",
        type: "number",
        default: "50",
        description: "Max results",
      },
    ],
    outputShape:
      "ListEnvelope<{ personId, name, email, score }>",
    errors: permErrors("auth.page.person.read"),
    examples: ["ib person search 'Matti'"],
  },

  // ─── vehicle (4) ─────────────────────────────────────────────────────────
  {
    command: "ib vehicle list",
    description:
      "List vehicles visible to the active company. ownerAsiakasId derived from JWT.",
    permissions: ["auth.page.vehicle.read"],
    flags: [
      {
        name: "limit",
        type: "number",
        default: "100",
        description: "Max rows (capped at 500)",
      },
    ],
    outputShape:
      "ListEnvelope<{ vehicleId, plate, type, capacity }>",
    errors: permErrors("auth.page.vehicle.read"),
    examples: ["ib vehicle list", "ib vehicle list --pretty"],
  },
  {
    command: "ib vehicle get",
    description: "Get a single vehicle by id.",
    permissions: ["auth.page.vehicle.read"],
    flags: [
      {
        name: "vehicleId",
        type: "number",
        description: "Positional — vehicleId to fetch",
      },
    ],
    outputShape: "{ vehicleId, plate, type, capacity }",
    errors: [
      { code: 404, meaning: "Vehicle not found", remedy: "verify vehicleId" },
      ...permErrors("auth.page.vehicle.read"),
    ],
    examples: ["ib vehicle get 7"],
  },
  {
    command: "ib vehicle status",
    description:
      "Current operational status for a vehicle: current driver, current keikka, latest GPS ping (via Ecofleet, best-effort).",
    permissions: ["auth.page.vehicle.read"],
    flags: [
      {
        name: "vehicleId",
        type: "number",
        description: "Positional — vehicleId to inspect",
      },
    ],
    outputShape:
      "{ vehicleId, plate, currentDriver:{personId,name}|null, currentKeikka:{keikkaId,tila}|null, lastGpsPing:{lat,lng,at}|null }",
    errors: [
      { code: 404, meaning: "Vehicle not found", remedy: "verify vehicleId" },
      ...permErrors("auth.page.vehicle.read"),
    ],
    examples: ["ib vehicle status 7", "ib vehicle status 7 --pretty"],
  },
  {
    command: "ib vehicle drivers",
    description: "Driver assignment history for a vehicle within a date range.",
    permissions: ["auth.page.vehicle.read"],
    flags: [
      {
        name: "vehicleId",
        type: "number",
        description: "Positional — vehicleId to inspect",
      },
      {
        name: "from",
        type: "date",
        default: "today",
        description: "Start date (YYYY-MM-DD or today/yesterday/tomorrow)",
      },
      {
        name: "to",
        type: "date",
        default: "today",
        description: "End date (YYYY-MM-DD or today/yesterday/tomorrow)",
      },
    ],
    outputShape:
      "ListEnvelope<{ pvm, driverId, driverName, shiftStart, shiftEnd }>",
    errors: [
      { code: 404, meaning: "Vehicle not found", remedy: "verify vehicleId" },
      ...permErrors("auth.page.vehicle.read"),
    ],
    examples: ["ib vehicle drivers 7 --from 2026-05-01 --to 2026-05-31"],
  },

  // ─── sijainti (4) ────────────────────────────────────────────────────────
  {
    command: "ib sijainti list",
    description:
      "List geocoded locations (sijainnit) — depots, plants, customer destinations. Optional --type filters by sijaintiTypeId.",
    permissions: ["auth.page.sijainnit.read"],
    flags: [
      {
        name: "type",
        type: "number",
        description: "Filter by sijaintiTypeId",
      },
      {
        name: "limit",
        type: "number",
        default: "100",
        description: "Max rows (capped at 500)",
      },
    ],
    outputShape:
      "ListEnvelope<{ sijaintiId, name, address, coords:{lat,lng}, type }>",
    errors: permErrors("auth.page.sijainnit.read"),
    examples: ["ib sijainti list", "ib sijainti list --type 1"],
  },
  {
    command: "ib sijainti get",
    description: "Get a single sijainti by id.",
    permissions: ["auth.page.sijainnit.read"],
    flags: [
      {
        name: "sijaintiId",
        type: "number",
        description: "Positional — sijaintiId to fetch",
      },
    ],
    outputShape:
      "{ sijaintiId, name, address, coords:{lat,lng}, type }",
    errors: [
      { code: 404, meaning: "Sijainti not found", remedy: "verify sijaintiId" },
      ...permErrors("auth.page.sijainnit.read"),
    ],
    examples: ["ib sijainti get 42"],
  },
  {
    command: "ib sijainti create",
    description:
      "Create a new sijainti via POST /api/geocode/sijainti/add. Body forwarded verbatim.",
    permissions: ["auth.page.sijainnit.edit"],
    flags: [
      {
        name: "body",
        type: "json",
        description: "JSON object with the new sijainti fields",
      },
    ],
    writeFlags: true,
    outputShape: "{ sijaintiId, ... } (raw backend response)",
    errors: [
      { code: 400, meaning: "Validation failed", remedy: "fix --body fields" },
      ...permErrors("auth.page.sijainnit.edit"),
    ],
    examples: [
      "ib sijainti create --body '{\"name\":\"Depot A\",\"address\":\"Industrial St 1\",\"sijaintiTypeId\":1}'",
    ],
  },
  {
    command: "ib sijainti update",
    description:
      "Update a sijainti via POST /api/geocode/updateSijainti. Body forwarded verbatim.",
    permissions: ["auth.page.sijainnit.edit"],
    flags: [
      {
        name: "body",
        type: "json",
        description: "JSON object with the fields to update (must include sijaintiId)",
      },
    ],
    writeFlags: true,
    outputShape: "{ ok: true, ... } (raw backend response)",
    errors: [
      { code: 400, meaning: "Validation failed", remedy: "fix --body fields" },
      { code: 404, meaning: "Sijainti not found", remedy: "verify sijaintiId" },
      ...permErrors("auth.page.sijainnit.edit"),
    ],
    examples: [
      "ib sijainti update --body '{\"sijaintiId\":42,\"name\":\"Renamed depot\"}'",
    ],
  },

  // ─── schedule (3) ────────────────────────────────────────────────────────
  {
    command: "ib schedule today",
    description:
      "List today's keikkas for the active company. Wrapper around `ib keikka list --from today --to today`.",
    permissions: ["auth.page.grid.tilaus.read"],
    flags: [],
    outputShape:
      "ListEnvelope<{ keikkaId, pvm, asiakasId, tyomaaId, vehicleId, tila, m3, time }>",
    errors: permErrors("auth.page.grid.tilaus.read"),
    examples: ["ib schedule today", "ib schedule today --pretty"],
  },
  {
    command: "ib schedule day",
    description: "List keikkas for a specific day.",
    permissions: ["auth.page.grid.tilaus.read"],
    flags: [
      {
        name: "date",
        type: "date",
        description:
          "Positional — date (YYYY-MM-DD or today/yesterday/tomorrow)",
      },
    ],
    outputShape:
      "ListEnvelope<{ keikkaId, pvm, asiakasId, tyomaaId, vehicleId, tila, m3, time }>",
    errors: permErrors("auth.page.grid.tilaus.read"),
    examples: ["ib schedule day 2026-06-01", "ib schedule day tomorrow"],
  },
  {
    command: "ib schedule week",
    description:
      "List keikkas for a 7-day window starting at the given date.",
    permissions: ["auth.page.grid.tilaus.read"],
    flags: [
      {
        name: "start",
        type: "date",
        description:
          "Positional — week start date (YYYY-MM-DD or today/yesterday/tomorrow)",
      },
    ],
    outputShape:
      "ListEnvelope<{ keikkaId, pvm, asiakasId, tyomaaId, vehicleId, tila, m3, time }>",
    errors: permErrors("auth.page.grid.tilaus.read"),
    examples: ["ib schedule week 2026-06-01", "ib schedule week today"],
  },

  // ─── v1.0.1 additions: customer/worksite/person lifecycle (11) ──────────
  {
    command: "ib customer delete",
    description: "Delete a customer (asiakas). Requires --reason; --dry-run available.",
    permissions: ["auth.page.asiakas.edit"],
    flags: [
      { name: "reason", type: "string", description: "Audit-log reason (REQUIRED)" },
    ],
    writeFlags: true,
    outputShape: "{ deleted: number } or { dryRun: true, wouldDelete: number }",
    errors: [
      { code: 404, meaning: "Customer not found", remedy: "verify asiakasId" },
      ...permErrors("auth.page.asiakas.edit"),
    ],
    examples: ['ib customer delete 9001 --reason "lifecycle cleanup"'],
  },
  {
    command: "ib customer person add",
    description: "Attach a person to a customer (asiakasPerson). Requires --reason.",
    permissions: ["auth.page.asiakas.edit"],
    flags: [
      { name: "asiakas", type: "number", description: "Target asiakasId (REQUIRED)" },
      { name: "person", type: "number", description: "Target personId (REQUIRED)" },
      { name: "contact-type", type: "number", default: "1", description: "contactPersonTypeId (1 = pumppari)" },
      { name: "reason", type: "string", description: "Audit-log reason (REQUIRED)" },
    ],
    writeFlags: true,
    outputShape: "{ added: { asiakasId, personId } } or write-success envelope",
    errors: [
      { code: 400, meaning: "Company limit (26) reached", remedy: "remove an existing link first" },
      ...permErrors("auth.page.asiakas.edit"),
    ],
    examples: ['ib customer person add --asiakas 26 --person 5351 --contact-type 1 --reason "onboard driver"'],
  },
  {
    command: "ib customer person remove",
    description: "Detach a person from a customer (asiakasPerson). Requires --reason.",
    permissions: ["auth.page.asiakas.edit"],
    flags: [
      { name: "asiakas", type: "number", description: "Target asiakasId (REQUIRED)" },
      { name: "person", type: "number", description: "Target personId (REQUIRED)" },
      { name: "contact-type", type: "number", default: "1", description: "contactPersonTypeId" },
      { name: "reason", type: "string", description: "Audit-log reason (REQUIRED)" },
    ],
    writeFlags: true,
    outputShape: "{ removed: { asiakasId, personId } }",
    errors: [
      { code: 404, meaning: "Link not found", remedy: "verify asiakasId+personId combination" },
      ...permErrors("auth.page.asiakas.edit"),
    ],
    examples: ['ib customer person remove --asiakas 26 --person 5351 --reason "offboard driver"'],
  },
  {
    command: "ib customer person list",
    description: "List persons attached to a customer. Optional --role filter.",
    permissions: ["auth.page.asiakas.read"],
    flags: [
      { name: "role", type: "string", description: "Filter by role name (e.g. keikkaHandler)" },
    ],
    outputShape: "ListEnvelope<{ personId, name, email, role }>",
    errors: [
      { code: 400, meaning: "Unknown role name", remedy: "see ROLE_TYPEID_BY_NAME in @ibetoni/constants" },
      ...permErrors("auth.page.asiakas.read"),
    ],
    examples: ["ib customer person list 26", "ib customer person list 26 --role keikkaHandler"],
  },
  {
    command: "ib worksite delete",
    description: "Delete a worksite (tyomaa). Requires --reason.",
    permissions: ["auth.page.tyomaa.edit"],
    flags: [
      { name: "reason", type: "string", description: "Audit-log reason (REQUIRED)" },
    ],
    writeFlags: true,
    outputShape: "{ deleted: number }",
    errors: [
      { code: 404, meaning: "Worksite not found", remedy: "verify tyomaaId" },
      ...permErrors("auth.page.tyomaa.edit"),
    ],
    examples: ['ib worksite delete 99 --reason "lifecycle cleanup"'],
  },
  {
    command: "ib worksite person add",
    description: "Attach a person to a worksite (tyomaaPerson). Requires --reason.",
    permissions: ["auth.page.tyomaa.edit"],
    flags: [
      { name: "worksite", type: "number", description: "Target tyomaaId (REQUIRED)" },
      { name: "person", type: "number", description: "Target personId (REQUIRED)" },
      { name: "contact-type", type: "number", default: "1", description: "contactPersonTypeId" },
      { name: "reason", type: "string", description: "Audit-log reason (REQUIRED)" },
    ],
    writeFlags: true,
    outputShape: "{ added: { tyomaaId, personId } }",
    errors: permErrors("auth.page.tyomaa.edit"),
    examples: ['ib worksite person add --worksite 99 --person 5351 --reason "assign foreman"'],
  },
  {
    command: "ib worksite person remove",
    description: "Detach a person from a worksite. Requires --reason.",
    permissions: ["auth.page.tyomaa.edit"],
    flags: [
      { name: "worksite", type: "number", description: "Target tyomaaId (REQUIRED)" },
      { name: "person", type: "number", description: "Target personId (REQUIRED)" },
      { name: "contact-type", type: "number", default: "1", description: "contactPersonTypeId" },
      { name: "reason", type: "string", description: "Audit-log reason (REQUIRED)" },
    ],
    writeFlags: true,
    outputShape: "{ removed: { tyomaaId, personId } }",
    errors: [
      { code: 404, meaning: "Link not found", remedy: "verify tyomaaId+personId combination" },
      ...permErrors("auth.page.tyomaa.edit"),
    ],
    examples: ['ib worksite person remove --worksite 99 --person 5351 --reason "rotation"'],
  },
  {
    command: "ib worksite person list",
    description: "List persons attached to a worksite.",
    permissions: ["auth.page.tyomaa.read"],
    flags: [],
    outputShape: "ListEnvelope<{ personId, name, email, contactType }>",
    errors: permErrors("auth.page.tyomaa.read"),
    examples: ["ib worksite person list 99"],
  },
  {
    command: "ib person create",
    description: "Create a person. Body REQUIRED via --body. Requires --reason.",
    permissions: ["auth.page.person.edit"],
    flags: [
      { name: "body", type: "json", description: "Person body. Must include personFirstName, personLastName, personEmail." },
      { name: "reason", type: "string", description: "Audit-log reason (REQUIRED)" },
    ],
    writeFlags: true,
    outputShape: "{ personId: number, ... } or { dryRun: true, wouldCreate: ... }",
    errors: [
      { code: 400, meaning: "Body missing required field", remedy: "include personFirstName, personLastName, personEmail" },
      ...permErrors("auth.page.person.edit"),
    ],
    examples: [
      'ib person create --body \'{"personFirstName":"Matti","personLastName":"M","personEmail":"m@x.com"}\' --reason "onboard"',
    ],
  },
  {
    command: "ib person update",
    description: "Update a person. Body REQUIRED via --body. Requires --reason.",
    permissions: ["auth.page.person.edit"],
    flags: [
      { name: "body", type: "json", description: "Patch body (JSON)" },
      { name: "reason", type: "string", description: "Audit-log reason (REQUIRED)" },
    ],
    writeFlags: true,
    outputShape: "{ ok: true, updated: { personId } }",
    errors: [
      { code: 404, meaning: "Person not found", remedy: "verify personId" },
      ...permErrors("auth.page.person.edit"),
    ],
    examples: ['ib person update 5351 --body \'{"personPhone":"+358501234567"}\' --reason "phone change"'],
  },
  {
    command: "ib person delete",
    description: "Delete a person. Requires --reason.",
    permissions: ["auth.page.person.edit"],
    flags: [
      { name: "reason", type: "string", description: "Audit-log reason (REQUIRED)" },
    ],
    writeFlags: true,
    outputShape: "{ deleted: number }",
    errors: [
      { code: 404, meaning: "Person not found", remedy: "verify personId" },
      ...permErrors("auth.page.person.edit"),
    ],
    examples: ['ib person delete 5351 --reason "departed"'],
  },

  // ─── schema (7) — developer-only SQL introspection ─────────────────────────
  ...((): CommandSpec[] => {
    const DEV_PERMS = ["developer access (isSystemAdmin or isDeveloper)"];
    const devErrors = [
      { code: 401, meaning: "Token expired", remedy: "ib auth refresh" },
      { code: 403, meaning: "Not a developer", remedy: "requires isSystemAdmin or isDeveloper" },
      { code: 500, meaning: "Backend error", remedy: "retry with --verbose" },
    ];
    const listFlags = [
      { name: "search", type: "string", description: "Filter object names by substring" },
      { name: "limit", type: "number", default: "200", description: "Max rows (max 1000)" },
    ];
    return [
      {
        command: "ib schema tables",
        description: "List dbo base tables with column counts. Developer-only.",
        permissions: DEV_PERMS,
        flags: listFlags,
        outputShape: "{ items: [{ name, type:'table', columnCount }], nextCursor: null, count }",
        errors: devErrors,
        examples: ["ib schema tables", "ib schema tables --search keikka"],
      },
      {
        command: "ib schema table",
        description: "Columns (type, nullability, default, key), primary key, foreign keys, and indexes for one dbo table. Developer-only.",
        permissions: DEV_PERMS,
        flags: [],
        outputShape: "{ name, columns:[{name,dataType,maxLength,nullable,default,key}], primaryKey:[…], foreignKeys:[{column,refTable,refColumn}], indexes:[{name,columns,unique}] }",
        errors: [...devErrors, { code: 404, meaning: "Table not found", remedy: "check the name via `ib schema tables`" }],
        examples: ["ib schema table keikka"],
      },
      {
        command: "ib schema views",
        description: "List dbo views with column counts. Developer-only.",
        permissions: DEV_PERMS,
        flags: listFlags,
        outputShape: "{ items: [{ name, type:'view', columnCount }], nextCursor: null, count }",
        errors: devErrors,
        examples: ["ib schema views"],
      },
      {
        command: "ib schema view",
        description: "Columns and full definition (T-SQL) for one dbo view. Developer-only.",
        permissions: DEV_PERMS,
        flags: [],
        outputShape: "{ name, columns:[…], definition:'<T-SQL>' }",
        errors: [...devErrors, { code: 404, meaning: "View not found", remedy: "check the name via `ib schema views`" }],
        examples: ["ib schema view keikkaBetoniView"],
      },
      {
        command: "ib schema procs",
        description: "List dbo stored procedures and functions (P/FN/TF/IF). Developer-only.",
        permissions: DEV_PERMS,
        flags: listFlags,
        outputShape: "{ items: [{ name, type:'P'|'FN'|'TF'|'IF' }], nextCursor: null, count }",
        errors: devErrors,
        examples: ["ib schema procs", "ib schema procs --search asiakas"],
      },
      {
        command: "ib schema proc",
        description: "Signature (parameters) and full definition (T-SQL) for one dbo proc/function. Developer-only.",
        permissions: DEV_PERMS,
        flags: [],
        outputShape: "{ name, type, parameters:[{name,dataType,mode}], definition:'<T-SQL>' }",
        errors: [...devErrors, { code: 404, meaning: "Proc/function not found", remedy: "check the name via `ib schema procs`" }],
        examples: ["ib schema proc asiakas_find"],
      },
      {
        command: "ib schema dump",
        description: "Structural map of the whole dbo schema — all tables (columns+keys), FK edges, view names, and proc signatures. No proc/view bodies (use `schema proc`/`schema view` for those). Developer-only.",
        permissions: DEV_PERMS,
        flags: [],
        outputShape: "{ tables:[{name,columns}], foreignKeys:[{table,column,refTable,refColumn}], views:[{name}], procs:[{name,type,parameters}] }",
        errors: devErrors,
        examples: ["ib schema dump"],
      },
    ];
  })(),

  // ─── reference (1) ───────────────────────────────────────────────────────
  {
    command: "ib reference dump",
    description:
      "Emit the full command surface as JSON (version, generatedAt, commands map). Read by AI assistants for one-shot CLI ingestion.",
    flags: [],
    outputShape:
      "{ version: string, generatedAt: ISO-8601, commands: { '<command>': CommandSpec } }",
    errors: [
      { code: 1, meaning: "I/O error", remedy: "retry; check stdout pipe" },
    ],
    examples: ["ib reference dump", "ib reference dump | jq .version"],
  },
];
