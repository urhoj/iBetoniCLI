# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

`@ibetoni/cli` — the `ib` command-line tool for betoni.online. It is a submodule of the `betoni-online-workspace` monorepo; the workspace-root `CLAUDE.md` (at `code/CLAUDE.md`) covers monorepo-wide rules and the iBetoni shared packages. This file covers only the CLI.

## What this CLI is for

`ib` is built **for AI assistants and CI/CD, not humans**. Every design choice follows from that:

- **stdout is JSON, always** — one line, machine-parseable. `--pretty` switches to human tables (cli-table3), `--json` (default) forces JSON.
- **stderr carries diagnostics and errors** — never mix into stdout.
- **Exit codes are a documented contract** (`src/api/errors.ts` `exitCodeFromStatus`): `0` success · `2` auth (401) · `3` permission (403) · `4` validation (4xx) · `5` not-found (404) · `6` server (5xx) · `7` network. Preserve this mapping.
- **`--help` is self-contained** — each command's help lists flags, permissions, output shape, error remedies, and copy-paste examples, so an AI can invoke it correctly from help alone.

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

`COMMAND_SPECS` is the canonical catalogue of every subcommand (description, permissions, flags, output shape, errors, examples). It drives **two** consumers that must never drift:

1. `src/output/help.ts` `attachRichHelp` — replaces each matching command's `--help` with the rich `formatHelp(spec)` rendering.
2. `src/reference/dump.ts` — `ib reference dump` emits all specs as one JSON document for one-shot AI ingestion.

**When you add or change a command, update its `CommandSpec` in `specs.ts` in the same change.** Two tests enforce the link: `test/reference/help-wiring.test.ts` (every spec maps to a registered command and its `--help` equals `formatHelp(spec)`) and `test/reference/help-snapshots.test.ts` (snapshot of rendered help — update with `npx vitest run -u` when intentional).

### Command registration

`src/program.ts` `buildProgram()` wires the whole Commander tree without parsing argv (so tests can import it). Each domain has a `src/commands/<domain>/index.ts` exporting a `register<Domain>Commands(parent, getClient)` function. `bin/ib.ts` is a thin shell: build program, set output mode on `--pretty`, `parseAsync`.

The `getClient: () => Promise<ApiClient>` factory is passed into every domain registrar. It lazily builds the authenticated client and exits `2` with "Not logged in" if no auth resolves — so command actions never deal with the unauthenticated case. `auth` commands are the exception: they touch the credential store directly and take no `getClient`.

### Command implementation pattern

Keep the network/transform logic in an exported pure `run*` function (e.g. `runCompanyList(client)`) that returns plain data, and keep the Commander `.action()` thin: call `getClient()`, call the `run*` fn, `writeJson(result)`, and `catch { writeError(e); process.exit(...) }`. Tests exercise the `run*` functions against a mock `ApiClient` — they do not spawn the CLI. Follow this split for every new command.

### API client (`src/api/client.ts`)

`createApiClient` returns `{ get, post, put, delete, getCurrentToken }`. It sets `Authorization: Bearer`, `User-Agent` (`ib-cli/<version>`), and `X-Request-ID`. Non-2xx responses throw a `CliError` carrying `statusCode`, parsed `body`, and the mapped `exitCode`.

**Refresh-on-401**: if an `onRefresh` callback is wired (file-backed sessions only), the *first* 401 transparently mints a fresh JWT and retries once; a second 401 surfaces. `cliContext.ts` supplies that callback and persists the rotated token back to disk. `IB_TOKEN` (env) sessions are non-refreshable — a 401 surfaces immediately.

### List envelope

Anything list-shaped returns `ListEnvelope<T> = { items, nextCursor, count }` (`src/api/envelopes.ts`). The pretty renderer auto-detects it. Project backend responses into this shape inside the `run*` function rather than passing raw backend shapes through.

### Write-safety flags (`src/api/writeFlags.ts`)

Every mutation command attaches the three universal flags via `addWriteFlagsToCommand`, mapped to headers by `writeFlagsToHeaders`: `--dry-run` → `X-Dry-Run: 1`, `--idempotency-key` → `Idempotency-Key`, `--reason` → `X-Action-Reason` (audit log). Pass the resulting headers into `client.post(..., { headers })`. Several v1.0.1 lifecycle commands (delete/person add-remove) make `--reason` effectively required — check the spec.

`--dry-run` is **server-side per handler** (the backend skips persistence when it honours `X-Dry-Run`) — so a `--dry-run` against an endpoint whose guard is not deployed will still persist. Read-merge-write commands instead resolve `--dry-run` **client-side** (e.g. `vehicle update` returns a `wouldChange` field-level diff via `src/diff.ts` and never POSTs) — safe-by-construction, but skips backend validation.

### Read-only mode (`--read-only` / `IB_READ_ONLY`)

A session write-lock for AI/CI use. Set the `--read-only` global flag or `IB_READ_ONLY=1`; `getGlobalOptions` resolves it into `GlobalOptions.readOnly`, `cliContext` passes it to `createApiClient`, and the client refuses every **non-GET** request (exit `3`) before any fetch — the single chokepoint guaranteeing no create/update/delete leaves the process. GETs (including the read half of a read-merge-write) still work.

### Command discovery (`ib commands`)

`ib commands` is an **offline** filtered view over `COMMAND_SPECS` (`src/reference/commandsList.ts`) — lighter than `ib reference dump`. Flags: `--mutations` (writes only), `--reads` (read-only only; named `--reads` not `--read-only` to avoid colliding with the global write-lock), `--permission <substr>`. Returns the `{ items, nextCursor, count }` envelope.

### Acting-as write diagnostic

On the **first write** of a process (the first non-GET that passes the read-only gate), the client prints one stderr line naming the target company — `[ib] write → asiakasId <N> (<name>)`, with a loud `⚠ BetoniJerry umbrella tenant` when `N === 1349`. A guardrail against "wrong company lens" writes after a company switch. `cliContext` decodes the JWT (free) into `actingAs` and passes it + `quiet` to `createApiClient`; suppressed by `--quiet`. stderr only — never pollutes the stdout JSON contract.

### `ib doctor`

One aggregated health report (`src/commands/doctor/index.ts`). Derives identity from the active JWT (works for both file- and `IB_TOKEN`-sessions, unlike `auth whoami` which reads the credentials file), reports token expiry, reuses `runVersion` for connectivity + deployed build, and does one authenticated read (`runCompanyList`) to prove the token works against the endpoint. Read-only; exits `1` when the aggregate `ok` is false.

### `ib vehicle list` filters

Rows are self-describing — each carries `showInGrid`/`firstDate`/`lastDate`/`deletedTime` alongside `{ vehicleId, plate, type, capacity }`. **Default scope is unchanged**: non-deleted, no narrowing — grid-hidden AND expired vehicles ARE included; only soft-deleted are excluded. Opt-in narrowing: `--deleted` (reveal soft-deleted), `--grid-only` (`showInGrid=1`), `--valid-on <date>` (validity window covers the day), `--type <id>`. The backend half (params + projection + cache-key compatibility) lives in `puminet5api` `listVehiclesForCli` / `vehicleCliRoutes.js` — **deploy-gated** (flags no-op until that backend deploys).

### `ib feedback` (AI self-service proposals / trouble reports)

`src/commands/feedback/` — when the AI hits friction using `ib`, it files a freetext note so the CLI can be improved. `create` (any user) `list`/`get`/`resolve` (developer-only) over `puminet5api` `/api/feedback` (a **silent** sink: no GitHub issue, no email, no notification — deliberately separate from `bugReport`). A developer-gated analyzer skill (`code/.claude/skills/analyze-cli-feedback`) reads them back and closes the loop.

**`meta` read-only exemption:** `create` is sent with `client.post(..., { meta: true })`. In `src/api/client.ts` the read-only write-lock and the acting-as diagnostic both skip `meta` requests — so an agent running `--read-only` / `IB_READ_ONLY` can *still* file feedback (it's not a domain mutation). `meta` is the ONLY write-lock bypass; use it only for non-mutating diagnostics. `resolve` is a real write (PUT, blocked under read-only). `--dry-run` on `create`/`resolve` resolves **client-side** (prints the payload, never sends) — not the server `X-Dry-Run`. Specs keep `writeFlags:false` (custom semantics; the standard write-safety block would mis-document them) — so `ib commands --reads` lists them. **Deploy-gated**: `/api/feedback` + the `cliFeedback` table must deploy first.

### Auth & credentials (`src/auth/`)

- `resolve.ts` — `IB_TOKEN` env var wins (CI, non-refreshable); else the credentials file. Returns `null` if neither exists.
- `store.ts` — `~/.ibetoni/credentials.json`, mode `0600`, multi-profile (`schemaVersion: 1`, `profiles`, `activeProfile`). `login`/`logout`/`switch`/`refresh` live alongside.
- Login is OAuth 2.1 + PKCE (`pkce.ts`, `callbackServer.ts`, `login.ts`) opening the system browser.
- `company switch` / `auth switch` mint a new JWT bound to the target `ownerAsiakasId` and persist it.

### Domain vocabulary (Finnish)

The backend speaks Finnish; the CLI mostly preserves it: `keikka` (delivery order), `asiakas` (customer), `tyomaa` (worksite), `sijainti` (geocoded location), `tila` (status), `pvm` (date), `m3` (cubic metres). Roles map via `ROLE_NAME_BY_TYPEID` / `ROLE_TYPEID_BY_NAME` from `@ibetoni/constants`.

## Conventions

- **ESM + explicit `.js` import extensions.** Source is `.ts` but relative imports must use the `.js` extension (e.g. `import { foo } from "./globals.js"`) — required by the ESM output. tsconfig `moduleResolution: "Bundler"`, `type: "module"`.
- **`strict` TypeScript.** `no-explicit-any` is a warning; avoid it.
- **`src/dates.ts` `resolveDate`** expands `today`/`yesterday`/`tomorrow` to `YYYY-MM-DD`; any other string passes through for the backend to validate. Use it for every date flag.
- Dates are interpreted in the active company timezone (Europe/Helsinki) — the help text states this for date commands.

## Testing

- Vitest, `globals: false` (import `describe`/`test`/`expect`/`vi` explicitly). Tests live in `test/` mirroring `src/`.
- Mock the `ApiClient` with `vi.fn()` for `get/post/put/delete/getCurrentToken`; assert on the exact path/body and the projected return shape (see `test/commands/company.test.ts`).
- After changing help/spec rendering, refresh snapshots: `npx vitest run -u`.

## CI

`.github/workflows/ci.yml` runs lint + type-check + tests; `publish.yml` publishes the package. Run `npm run lint && npm run type-check && npm test` locally before pushing.
