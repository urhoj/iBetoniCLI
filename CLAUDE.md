# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

`@ibetoni/cli` — the `ib` command-line tool for betoni.online. It is a submodule of the `betoni-online-workspace` monorepo; the workspace-root `CLAUDE.md` (at `code/CLAUDE.md`) covers monorepo-wide rules and the iBetoni shared packages. This file covers only the CLI.

## What this CLI is for

`ib` is built **for AI assistants and CI/CD, not humans**. Every design choice follows from that:

- **stdout is JSON, always** — one line, machine-parseable. `--pretty` switches to human tables (cli-table3), `--json` (default) forces JSON.
- **stderr carries diagnostics and errors** — never mix into stdout.
- **Exit codes are a documented contract** (`src/api/errors.ts` `exitCodeFromStatus`): `0` success (incl. --help/--version) · `1` generic (bare `ib`/group help render, `auth login` failure, `doctor` not-ok, unexpected runtime errors) · `2` auth (401) · `3` permission (403) · `4` validation (4xx AND parser usage errors, emitted as the JSON envelope with code `USAGE` via `handleParseRejection`) · `5` not-found (404) · `6` server (5xx) · `7` network. Every error path emits the JSON envelope; never call `process.exit()` (Windows-unsafe post-fetch — use `failWith`/`exitWithError`/`process.exitCode`). Preserve this mapping.
- **`--help` for commands is self-contained** — each command's help renders from bundled `CommandSpec` and lists flags, permissions, output shape, error remedies, and copy-paste examples, so an AI can invoke it correctly from help alone. The root `ib --help` additionally includes a GLOSSARY section fetched live from the DB (`ib glossary`); when offline or tokenless, that section is omitted but the rest of the help renders normally.

## Commands

Run from the `betonicli/` directory:

- `npm run dev -- <args>` — run the CLI from source via tsx, e.g. `npm run dev -- keikka list --pretty`
- `npm run build` — compile `src/` → `dist/` (tsc); `bin` entry is `dist/bin/ib.js`
- `npm test` — vitest run (all tests)
- `npm run test:watch` — vitest watch
- `npx vitest run test/commands/company.test.ts` — run a single test file
- `npm run lint` / `npm run lint:fix` — eslint (note: forced legacy `.eslintrc.cjs` via `ESLINT_USE_FLAT_CONFIG=false`)
- `npm run type-check` — `tsc --noEmit`

## Architecture

### Single source of truth: `src/reference/specs.ts`

`COMMAND_SPECS` is the canonical catalogue of every subcommand (`command`, `description`, optional `tier` (visibility gate — `"developer"` hides the command from non-developer/tokenless callers in every discovery surface; absent = visible to all), optional `auth` / `permissions`, positional `args`, `flags`, `writeFlags` / `mutates`, `outputShape`, dual-encoded `errors` (`{ http?, exit }`), optional `notes` / `seeAlso`, `examples`). It drives **three** consumers that must never drift:

1. `src/output/help.ts` `attachRichHelp` — replaces each matching command's `--help` with the rich `formatHelp(spec)` rendering, renders computed `formatGroupHelp` on every non-root GROUP command, and overwrites each leaf's Commander `.description()` with `spec.description` (the spec is the single source for leaf descriptions; `help-wiring.test.ts` asserts the equality).
2. `src/reference/dump.ts` — `ib reference dump [domain]` emits all specs (or one domain's) as one JSON document for AI ingestion; the primer (overview/glossary/topics/feedbackGuidance) is always retained.
3. `src/reference/commandsList.ts` — bare `ib commands` renders the domain index (`buildDomainIndex`); `ib commands <domain>` / `--all` / the filters (`--mutations` / `--reads` / `--permission`) filter the catalogue to flat per-command views. Also exports `commandDomains` / `assertKnownDomain` (unknown domain → exit 4), shared with the dump.

**When you add or change a command, update its `CommandSpec` in `specs.ts` in the same change.** Tests enforce the link: `test/reference/help-wiring.test.ts` (every spec maps to a registered command, **every leaf command has a spec**, and each `--help` equals `formatHelp(spec)`) and `test/reference/help-snapshots.test.ts` (snapshot of rendered help — update with `npx vitest run -u` when intentional). The `formatHelp` renderer itself is unit-tested in `test/output/help-format.test.ts` and `test/output/help.test.ts`.

### Command registration

`src/program.ts` `buildProgram()` wires the whole Commander tree without parsing argv (so tests can import it). Each domain has a `src/commands/<domain>/index.ts` exporting a `register<Domain>Commands(parent, getClient)` function. `bin/ib.ts` is a thin shell: build program, set output mode on `--pretty`, `parseAsync`.

The `getClient: () => Promise<ApiClient>` factory is passed into every domain registrar. It lazily builds the authenticated client and exits `2` with "Not logged in" if no auth resolves — so command actions never deal with the unauthenticated case. `auth` commands are the exception: they touch the credential store directly and take no `getClient`.

### Command implementation pattern

Keep the network/transform logic in an exported pure `run*` function (e.g. `runCompanyList(client)`) that returns plain data, and keep the Commander `.action()` thin: call `getClient()`, call the `run*` fn, `writeJson(result)`, and `catch { writeError(e); process.exit(...) }`. Tests exercise the `run*` functions against a mock `ApiClient` — they do not spawn the CLI. Follow this split for every new command.

### Dual-target ids (`src/targets.ts`)

Some commands accept their target id either as a positional OR a flag alias (`<asiakasId>` / `--asiakas`, `<tyomaaId>` / `--worksite`) — the dual-target pattern (feedback #28). Implement it by declaring the positional optional (`[asiakasId]`), adding `.option("--asiakas <id>", "Target asiakasId (alias for the positional)", Number)`, and resolving in the action via `resolveTarget(idStr, opts.asiakas, "asiakasId", "asiakas")` — or the `resolveAsiakasTarget` wrapper from `commands/customer` for the asiakas case. Exactly one is required; both are allowed only when they agree; any provided value that is not a positive integer exits 4. Used by customer modules/operator/settings/person-list, jerry admin detail/enable/disable, and worksite person list. (`sijainti closest` is the one flag-vs-flag pair — `--worksite`/`--tyomaa` — validated inline.) Primary-key commands (`get <id>`, `update <id>`, `delete <id>`, …) stay positional-only by design — do not add target flags to them. The global `--company` flag is the acting-as context and is distinct from local `--asiakas` target flags.

### API client (`src/api/client.ts`)

`createApiClient` returns `{ get, post, put, delete, getCurrentToken }`. It sets `Authorization: Bearer`, `User-Agent` (`ib-cli/<version>`), and `X-Request-ID`. Non-2xx responses throw a `CliError` carrying `statusCode`, parsed `body`, and the mapped `exitCode`.

**Refresh-on-401**: if an `onRefresh` callback is wired (file-backed sessions only), the *first* 401 transparently mints a fresh JWT and retries once; a second 401 surfaces. `cliContext.ts` supplies that callback and persists the rotated token back to disk. `IB_TOKEN` (env) sessions are non-refreshable — a 401 surfaces immediately.

### List envelope

Anything list-shaped returns `ListEnvelope<T> = { items, nextCursor, count, truncated? }` (`src/api/envelopes.ts`). The pretty renderer auto-detects it. Project backend responses into this shape inside the `run*` function rather than passing raw backend shapes through. `truncated: true` signals the result was capped at the row limit — required on any list with a cap and no real cursor (the backend CLI list routes emit it as an always-present boolean; client-side slicing in a `run*` fn must set it too, see `runSijaintiListJoined` / `log`'s `envelope()`).

### Write-safety flags (`src/api/writeFlags.ts`)

Every mutation command attaches the three universal flags via `addWriteFlagsToCommand`, mapped to headers by `writeFlagsToHeaders`: `--dry-run` → `X-Dry-Run: 1`, `--idempotency-key` → `Idempotency-Key`, `--reason` → `X-Action-Reason` (audit log). Pass the resulting headers into `client.post(..., { headers })`. Several v1.0.1 lifecycle commands (delete/person add-remove) make `--reason` effectively required — check the spec.

`--dry-run` is **server-side per handler** (the backend skips persistence when it honours `X-Dry-Run`) — so a `--dry-run` against an endpoint whose guard is not deployed will still persist. Read-merge-write commands instead resolve `--dry-run` **client-side** (e.g. `vehicle update` returns a `wouldChange` field-level diff via `src/diff.ts` and never POSTs) — safe-by-construction, but skips backend validation.

### Read-only mode (`--read-only` / `IB_READ_ONLY`)

A session write-lock for AI/CI use. Set the `--read-only` global flag or `IB_READ_ONLY=1`; `getGlobalOptions` resolves it into `GlobalOptions.readOnly`, `cliContext` passes it to `createApiClient`, and the client refuses every **non-GET** request (exit `3`) before any fetch — the single chokepoint guaranteeing no create/update/delete leaves the process. GETs (including the read half of a read-merge-write) still work.

### Command discovery (`ib commands`)

`ib commands` with NO arguments returns a compact **domain index** (~5 KB: one row per domain with leaf count, glossary blurb, and runnable command paths) — the cheapest discovery entry point. `ib commands <domain>` (the token after `ib`, e.g. `keikka`) returns that group's flat per-command list `{ command, description, permissions, isWrite }`; `ib commands --all` returns the full flat list (~43 KB). The domain positional and the filter flags compose and all return flat lists: `--mutations` (writes only), `--reads` (read-only only; named `--reads` not `--read-only` to avoid colliding with the global write-lock), `--permission <substr>`. `ib reference dump [domain]` takes the same positional (commands map narrowed, primer always retained). Unknown domain → exit 4 listing valid domains (single validation point: `assertKnownDomain`). Returns the `{ items, nextCursor, count }` envelope (the no-arg index adds a leading `hint` key). The root `ib --help` DISCOVER block advertises this progressive path: `ib commands` (domain index) → `ib commands <domain>` → `ib <command> --help` / `ib reference dump <domain>`.

The output is TIER-FILTERED on a rank ladder `standard < admin < developer`: a command tagged `tier: "developer"` is hidden from every non-developer/tokenless caller; `tier: "admin"` is hidden from callers below active-company admin/HR. The ambient tier is resolved once per invocation from the session token (`resolveCallerTier` in `src/tier.ts`), set by `bin/ib.ts` (file/IB_TOKEN sessions) and `runArgv.ts` (in-process). Fail-closed: no/invalid token → "standard" → privileged subtrees hidden. Fully-hidden domains (`ai`, `schema`, `changelog`) vanish from the domain index; `bug`/`jerry`/`message`/`feedback` show only their non-admin leaves. `ib reference dump`, group/leaf `--help`, and the root `--help` Commands list + primer/GLOSSARY apply the same filter. Pure rendering functions default to `tier: "developer"` so existing tests and direct library callers are unaffected.

### Group help (computed)

Non-root group commands (`ib keikka`, `ib jerry offer`, …) render `formatGroupHelp` (`src/output/help.ts`) instead of Commander's default: blurb = `DOMAIN_BLURBS[domain]` if present, otherwise the Commander description; subcommand table derived by prefix over `COMMAND_SPECS` (leaves show their description's first sentence; subgroups point at their `--help`); DISCOVER footer pointing at `ib reference dump <domain>`. Purely computed — no per-group spec to maintain or drift.

### Tier-gated discovery

`CommandSpec.tier?: "admin" | "developer"` is the machine-readable visibility gate, a rank ladder `standard < admin < developer`. A leaf tagged `tier:"developer"` is hidden from every non-developer/tokenless caller; `tier:"admin"` is hidden from everyone below active-company admin/HR. Hiding applies in: `ib commands` (index + flat list), group `--help`, leaf `--help` (renders a "not available at your access level" fallback via `hiddenAtTierMessage`), `ib reference dump` (commands map + GLOSSARY/primer + cross-reference scrub of `seeAlso`/`notes`/`examples`), and the root `--help` Commands list + ABOUT/GLOSSARY. Command *execution* is unchanged — hidden commands still register, parse, and 403 on the server. This is discovery/enumeration secrecy (defense-in-depth), not access control.

Tier resolution (`src/tier.ts`): `resolveCallerTier(token)` → `"developer"` if the JWT `globalRoles` has `isDeveloper`/`isSystemAdmin`; else `"admin"` if the active company (`ownerAsiakasId` in `asiakasesWithTypes`) grants `asiakasAdmin`/`hrAdmin`; else `"standard"` (fail-closed on no/bad token). An ambient holder (`get/setCallerTier`, default `"developer"` for library/test use) is set once per invocation before parse; `runArgv.ts` restores the prior value in `finally` (not race-safe under concurrent in-process calls — thread `tier` through `EmbeddedCtx` if `IB_EXEC_INPROCESS` goes live).

Tagged — **developer tier** (~38 leaves): `ai conversation`; all `schema` (7); `feedback list/get/resolve`; `cache stats/keys/clear/pattern` (4); `bug admin` (4); `jerry admin` (5); `message support inbox/resolve`; `legal save/activate/delete/acceptances/accept/type create/type update` (7); all `changelog` (5, co-located in `src/commands/changelog/index.ts`). **Admin tier** (2): `notification fcm send`; `person notify`. NOT tagged (per-tenant admin or open, stay visible): `feedback create`, `cache invalidate`, `cache entities`, `customer modules/operator/settings`, `jerry provider-settings`, `log latest/range/by-entity-date`, `ohje update`, `person owner`, `message support contact`, `message support mine`. Server MCP `list_ib_commands` is bound to the caller's token so the spawned `ib commands` resolves their tier; `/api/cli/exec` auto-gates.

### Acting-as write diagnostic

On the **first write** of a process (the first non-GET that passes the read-only gate), the client prints one stderr line naming the target company — `[ib] write → asiakasId <N> (<name>)`, with a loud `⚠ BetoniJerry umbrella tenant` when `N === 1349`. A guardrail against "wrong company lens" writes after a company switch. `cliContext` decodes the JWT (free) into `actingAs` and passes it + `quiet` to `createApiClient`; suppressed by `--quiet`. stderr only — never pollutes the stdout JSON contract.

### `ib doctor`

One aggregated health report (`src/commands/doctor/index.ts`). Derives identity from the active JWT (works for both file- and `IB_TOKEN`-sessions, unlike `auth whoami` which reads the credentials file), reports token expiry, reuses `runVersion` for connectivity + deployed build, and does one authenticated read (`runCompanyList`) to prove the token works against the endpoint. Read-only; exits `1` when the aggregate `ok` is false.

### `ib help <topic>`

Concept guides (`src/commands/help/index.ts`), distinct from each command's `--help`. Sourced from the `TOPICS` table in `src/reference/domain.ts` (one source of truth) — current topics: `roles`, `jerry-lifecycle`, `write-safety`, `exit-codes`, `multi-tenancy`, `log`, `attachments`. Known topics are resolved offline: `ib help` returns the list envelope `{ items:[{id,title}], nextCursor, count }`; `ib help <id>` returns `{ id, title, body }`. **Unknown topic fallback**: when no `TOPICS` entry matches, `runHelpTopic` calls `ib glossary lookup` (DB) and returns the glossary entry's definition as the body — so `ib help <finnish-word>` works for vocabulary too. If the DB returns 404, exit 5 with a hint listing valid topic ids and suggesting `ib glossary lookup <term>`. `TOPICS` is also embedded in `ib reference dump` under `topics`, and the ids are listed in the `ib --help` footer (via `renderDomainHelp`). The whole group is registered with `program.helpCommand(false)` in `program.ts` — that disables Commander's built-in implicit `help` command so our explicit `help [topic]` action runs; the `-h/--help` option is separate and unaffected.

### `ib vehicle list` filters

Rows are self-describing — each carries `showInGrid`/`firstDate`/`lastDate`/`deletedTime` alongside `{ vehicleId, plate, name, type, typeName, capacity }` (`name` ← `vehicleNimi`, `typeName` ← `vehicleTypes.vehicleTypeName`, null when unset; the numeric `type`/`vehicleTypeId` is retained for the `--type` filter). `search` matches reg-no / name / `vehicleNo` (fleet number) substrings. `ib vehicle get` returns the full "Perustiedot" record (adds `vehicleNo` (fleet number), `boomLength` ← `vehiclePuomi`, `sortNo`, validity dates, `memo`, `billingProductId`, `asiakasId`, and the behaviour toggles). **Default scope is unchanged**: non-deleted, no narrowing — grid-hidden AND expired vehicles ARE included; only soft-deleted are excluded. Opt-in narrowing: `--deleted` (reveal soft-deleted), `--grid-only` (`showInGrid=1`), `--valid-on <date>` (validity window covers the day), `--type <id>`. The backend half (params + projection + cache-key compatibility) lives in `puminet5api` `listVehiclesForCli` / `vehicleCliRoutes.js` — **deploy-gated** (flags no-op until that backend deploys).

### `ib feedback` (AI self-service proposals / trouble reports)

`src/commands/feedback/` — when the AI hits friction using `ib`, it files a freetext note so the CLI can be improved. `create` (any user) `list`/`get`/`resolve` (developer-only) over `puminet5api` `/api/feedback` (a **quiet** sink: no GitHub issue, no admin broadcast — deliberately separate from `bugReport`; a private heads-up email goes to the maintainer, personId 10). A developer-gated analyzer skill (`code/.claude/skills/analyze-cli-feedback`) reads them back and closes the loop.

**`meta` read-only exemption:** `create` is sent with `client.post(..., { meta: true })`. In `src/api/client.ts` the read-only write-lock and the acting-as diagnostic both skip `meta` requests — so an agent running `--read-only` / `IB_READ_ONLY` can *still* file feedback (it's not a domain mutation). `meta` is the ONLY write-lock bypass; use it only for non-mutating diagnostics. `resolve` is a real write (PUT, blocked under read-only). `--dry-run` on `create`/`resolve` resolves **client-side** (prints the payload, never sends) — not the server `X-Dry-Run`. Specs keep `writeFlags:false` (custom client-side dry-run; the standard write-safety block would mis-document them) but set `mutates:true`, so `ib commands` classifies them as writes via `mutates ?? !!writeFlags` — `--mutations` lists them and `--reads` excludes them. **Deploy-gated**: `/api/feedback` + the `cliFeedback` table must deploy first.

`list` caps each row's `description`/`resolution`/`errorText` at 200 chars by default (full text via `ib feedback get <id>` or `--full`); when anything was cut the envelope carries a `hint`. `--unresolved` (= `--status open,reviewed`) and a comma-separated `--status` fan out to one GET per status, merged newest-first client-side. `resolve` returns a compact ack `{ feedbackId, status, updatedAt, resolution }` by default (`--full` for the whole row). `ib feedback count` returns `{ total, byStatus, byKind, byScope }` aggregated client-side — the cheap "is there anything open?" call. All four are client-side only (no backend change).

### `ib message chat` — conversational thread CLI

`src/commands/message/chat/index.ts`. Six leaves over `/api/messages/threads/*` (Jerry tarjous threads now, keikka later):

- `threads` — inbox (GET `/threads/mine`); `--unread`/`--tarjous` filter client-side.
- `thread [id]` — metadata + participants.
- `list [id]` — messages oldest-first; does NOT mark read.
- `send [id] --body` — POST a message. `--dry-run` is **client-side only** (GETs participants, echoes `wouldSend`; the route has no `X-Dry-Run` guard, so a real POST would persist). `--reason` → `sourceNote`.
- `mark-read [id]` — stamps `lastReadAt`.
- `delete <messageId> --thread|--tarjous` — **soft-delete** (sets `isDeleted=1`; row kept for audit, invisible on every read). Authorization: a sysadmin/developer may moderate (delete any) in an accessible thread; everyone else may delete only their OWN message and only while **unanswered** (no later reply from a different participant → 409). Idempotent → `{ deleted:true }` or `{ deleted:true, alreadyDeleted:true }`. Emits a `message:deleted` socket event. `--dry-run` is **client-side only** (lists thread, echoes `wouldDelete`, no DELETE issued).

Every thread-targeting leaf resolves its thread from a raw `threadId` positional OR `--tarjous <pumppuRequestId>` via `resolveThreadId` (`./resolveThread.ts`); a tarjous with multiple threads requires an explicit `threadId`. `--tarjous` resolves through `/threads/mine`, so a non-participant moderator must pass the raw `--thread <id>`. send/mark-read/delete are writes (blocked under `--read-only`). The DELETE route is **deploy-gated** in `puminet5api`.

### Auth & credentials (`src/auth/`)

- `resolve.ts` — `IB_TOKEN` env var wins (CI, non-refreshable); else the credentials file. Returns `null` if neither exists.
- `store.ts` — `~/.ibetoni/credentials.json`, mode `0600`, multi-profile (`schemaVersion: 1`, `profiles`, `activeProfile`). `login`/`logout`/`switch`/`refresh` live alongside.
- Login is OAuth 2.1 + PKCE (`pkce.ts`, `callbackServer.ts`, `login.ts`) opening the system browser.
- `company switch` / `auth switch` mint a new JWT bound to the target `ownerAsiakasId` and persist it.

### `ib glossary`

The DB-backed domain vocabulary (`src/commands/glossary/index.ts`, backend `/api/cli/glossary/*`). Single source of truth for Finnish/colloquial term definitions, synonyms, and related commands. `lookup <term>` resolves a word or synonym to its entry (exit 5 + miss recorded when unknown); **comma-separated terms** (`lookup a,b,c`) trigger batch lookup — each term resolved in parallel, 404s returned as `{ found: false }` instead of throwing. On a miss, **did-you-mean** hints are appended to the error message (queried from `/glossary?search=` with the full term and a 5-char prefix). `list` returns all entries with optional `--search`/`--stalest`/`--domain`/`--related` filters. `set`/`import`/`delete`/`misses`/`lint` are developer-only — the `groom-ib-glossary` skill drives the grooming loop (reads `misses`, calls `set`).

**`lint`** (`ib glossary lint`) audits the entire glossary for dead `relatedCommands` (paths not in the current CLI catalogue), near-duplicate terms (Levenshtein distance 1), and empty required fields. Add `--strict` to exit 1 on any warn-level finding — suitable for CI.

**`import <file>`** bulk-sets entries from a JSON array file (or `-` for stdin). Avoids shell argv mangling of Finnish ä/ö characters that can corrupt multi-word definitions passed as CLI arguments. Each entry is processed sequentially; per-entry errors are collected without aborting the batch. `--update-only` restricts to existing terms (404 instead of insert) for safe grooming runs.

**`set` is a PARTIAL update (PATCH).** The CLI sends ONLY the fields you pass; an omitted flag is left out of the body, so the backend (`ibcli_glossary_save`, `COALESCE(@field, t.field)` per field) PRESERVES the current value. Pass an empty value to CLEAR: `--synonyms ""` → `[]`, `--entity ""` → `""`. So `ib glossary set puomi --synonyms "a,b"` updates only the synonyms and keeps the definition. Sending all fields (the groomer / `import` / `--from-json`) still does a full overwrite (COALESCE of non-null = the new value), so it's backward-compatible. The COALESCE save proc (`2026-06-18-glossary-save-partial.sql`) is deployed to prod, so partial preservation is live.

Append mode (developer-only, deploy-gated): `--add-synonyms` / `--remove-synonyms` (set-merge synonyms by normalized name) and `--append-definition` (single-space join with an endsWith no-op guard) edit in place without re-sending the whole field — for no-filesystem callers (MCP `ib_exec` / `/api/cli/exec`) that can't use `--from-json`. The merge runs server-side (`mergeAppend` + an uncached read in `modules/glossary/glossary.js`); the target term must already exist (404 otherwise). Mutually exclusive with the overwrite twin (`--definition` / `--synonyms`) → exit 4.

**Primer glossary is the term+synonyms INDEX only (no definitions).** Both the root `ib --help` GLOSSARY section (rendered `term (syn1, syn2)`) and `ib reference dump`'s `glossary` key carry `{ term, synonyms }` — definitions are deliberately dropped (`projectGlossaryForPrimer`) so they don't bloat every dump / help / AI primer as the glossary grows. Fetch a definition on demand with `ib glossary lookup <term>` (one) or `ib glossary list` (all). The `/ai` loop is unaffected — it has its own top-30-by-`runs` glossary message (`puminet5api modules/gpt/ib/ibGlossary.js`). Both primer surfaces are absent offline / tokenless.

### `ib perf` — SQL slow-query monitoring

`src/commands/perf/index.ts` — four `tier:"developer"` commands over the EXISTING `/api/admin/slow-queries*` routes (no backend deploy needed; the routes predate the group). All hidden from non-developer / tokenless callers in every discovery surface.

- `ib perf slow [--limit N] [--env name]` — recent slow queries from the Redis ring buffer as a `ListEnvelope` (`truncated:true` when the page filled the limit). `durationMs` is the row field (the backend sends `duration`, renamed in `runPerfSlow`); rows also carry `procedure`/`entity`/`params`/`timestamp`, plus envelope-level `totalCount`/`environment`.
- `ib perf stats [--env name]` — aggregate stats (top procedures by count/avgMs, avg/max/min, by-entity, lifetime `totalSlowQueries`).
- `ib perf config` — collector config (`enabled`/`threshold`/`sentryThreshold`/`maxEntries`); folds in `availableEnvironments` via a second GET to `/environments` (`Promise.all` with the config GET).
- `ib perf clear [--env name] --reason <r>` — DELETE the buffer. `--dry-run` is **client-side only** (the route honours no `X-Dry-Run`): it resolves before any fetch and returns `{ dryRun:true, wouldClear:{ method, path } }`. Blocked under `--read-only` / `IB_READ_ONLY`.

All three reads build their query suffix through one `qs()` helper. Coverage caveat (shared with `--stats`): only `executeQuery`-path stored procs are timed/collected — raw `getConnection()` queries are not.

### Global `--stats` flag

`src/stats.ts` — a process-singleton accumulator. `--stats` (resolved in `globals.ts` → `GlobalOptions.stats`, enabled in `bin/ib.ts`'s preAction) makes `src/api/client.ts` time each request and `recordRequest` it; `bin/ib.ts` calls `flushStats` once after `parseAsync`, emitting ONE line to **stderr** — never stdout (the JSON data contract is preserved; same channel as the acting-as write diagnostic). Three dimensions, summed across all requests in the invocation:

- `apiMs` — wall-clock round-trip (incl. any 401-refresh retry); always present. `apiReqCount` added (JSON) when >1.
- `sqlMs` / `sqlProcCount` / `sqlCoverage:"executeQuery-path-only"` — only when the backend emits a `Server-Timing: sql;dur=…;desc="N procs"` header (deploy-gated; absent on routes that don't hit the cache runner).
- `cacheHits` / `cacheMisses` — only when the backend emits `cacheHit`/`cacheMiss` Server-Timing metrics. Deliberately **absent** (not `0/0`) on routes that did no cached read, so raw-query routes don't read as "all misses". A cache hit shows `sqlMs:0` (no proc ran) with `cacheHits:1` — the pair disambiguates "served from cache" from "no SQL".

`--pretty` renders a human line: `[ib] stats: api=120ms sql=45ms (3 procs, executeQuery-path-only) cache=2 hit / 1 miss`. JSON mode emits `{"stats":{…}}`. The backend half lives in `puminet5api` (`modules/monitoring/requestSqlTiming.js` AsyncLocalStorage scope + `app.js` `Server-Timing` response wrapper).

### Domain vocabulary (Finnish)

The backend speaks Finnish; the CLI mostly preserves it: `keikka` (delivery order), `asiakas` (customer), `tyomaa` (worksite), `sijainti` (geocoded location), `tila` (status), `pvm` (date), `m3` (cubic metres). Roles map via `ROLE_NAME_BY_TYPEID` / `ROLE_TYPEID_BY_NAME` from `@ibetoni/constants`. The full live vocabulary with definitions is in `ib glossary` (DB-backed); `DOMAIN_BLURBS` (`src/reference/domain.ts`) is the offline per-domain one-liner source for `ib commands` (domain index) and computed group help.

## Conventions

- **ESM + explicit `.js` import extensions.** Source is `.ts` but relative imports must use the `.js` extension (e.g. `import { foo } from "./globals.js"`) — required by the ESM output. tsconfig `moduleResolution: "Bundler"`, `type: "module"`.
- **`strict` TypeScript.** `no-explicit-any` is a warning; avoid it.
- **`src/dates.ts` `resolveDate`** expands `today`/`yesterday`/`tomorrow` to `YYYY-MM-DD`; any other string passes through for the backend to validate. Use it for every date flag.
- Dates are interpreted in the active company timezone (Europe/Helsinki) — the help text states this for date commands.

## Testing

- Vitest, `globals: false` (import `describe`/`test`/`expect`/`vi` explicitly). Tests live in `test/` mirroring `src/`.
- Mock the `ApiClient` with `vi.fn()` for `get/post/put/delete/getCurrentToken`; assert on the exact path/body and the projected return shape (see `test/commands/company.test.ts`).
- After changing help/spec rendering, refresh snapshots: `npx vitest run -u`.

### Local backend e2e

Running `ib` against a local backend works (verified 2026-06-11): start it (`npm run dev:backend` from the workspace root; port = `SERVER_PORT` in `puminet5api/.env`, currently 8080), set `IB_TOKEN` to a JWT minted with the backend's `createToken` (`puminet5api/authz/verifyToken`; canonical claims: `ownerAsiakasId`, `tenantAsiakasId`, `globalRoles`, `asiakasesWithTypes`), and pass `--endpoint http://127.0.0.1:<port>`. `auth login --endpoint <local>` also works — the root global `--endpoint` is read by login (the historical shadowing bug that silently authorized against prod is fixed).

If verification fails with `invalid signature`: `puminet5api/app.js` loads `.env.development` first and `.env` as fallback fill — historically a STALE `JWT_KEY` copy in `.env.development` shadowed the real key and made the dev server reject every token (the 2026-06 blocker). Diagnose with `node puminet5api/utils/test/jwt-key-fingerprint.js` (prints non-secret fingerprints of both env files + the effective runtime key) and check `.env` ↔ Key Vault drift with `npm run env:rebuild:report` (in `puminet5api/`, needs `az login`). Also note `puminet5api/test/utils/generate-test-token.js` is stale (`/api/auth/authenticate` no longer exists) — mint via `createToken` instead.

## CI

`.github/workflows/ci.yml` runs lint + type-check + tests; `publish.yml` publishes the package. Run `npm run lint && npm run type-check && npm test` locally before pushing.
