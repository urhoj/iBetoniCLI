/**
 * Catalogue of every `ib` subcommand for v1.0.
 *
 * Each entry is a {@link CommandSpec} consumed by:
 *  - `src/output/help.ts`  → renders `--help` for the matching subcommand;
 *  - `src/reference/dump.ts` → emits the entire surface as JSON via
 *    `ib reference dump`, the single document an AI assistant ingests to
 *    learn the CLI in one shot.
 *
 * The catalogue is authored in per-domain segment files under
 * `./specs/` (split 2026-08-19, fb#782) and concatenated here in a fixed,
 * load-bearing order; this barrel remains the single import surface, so
 * human help and the machine reference still share one source of truth. Errors codes follow the universal exit-code map:
 *   401 = token expired (remedy: `ib auth refresh`)
 *   403 = permission denied (remedy: check the listed `auth.page.*`)
 *   404 = not found
 *   400 = validation
 *   500 = backend error
 */
import type { CommandSpec } from "../output/help.js";
// `ib message daily` / `ib message board` / `ib dev changelog` specs are
// co-located with their commands (one source of truth per sub-group) and
// spread in at their original positions.
import { MESSAGE_DAILY_SPECS } from "../commands/message/daily/index.js";
import { MESSAGE_BOARD_SPECS } from "../commands/message/board/index.js";
import { CHANGELOG_SPECS } from "../commands/changelog/index.js";
import { ATTACHMENT_SPECS } from "./specs/attachment.js";
import { AUTH_SPECS } from "./specs/auth.js";
import { COMPANY_SPECS } from "./specs/company.js";
import { KEIKKA_SPECS } from "./specs/keikka.js";
import { CUSTOMER_SPECS } from "./specs/customer.js";
import { WORKSITE_SPECS } from "./specs/worksite.js";
import { PERSON_SPECS } from "./specs/person.js";
import { VEHICLE_SPECS } from "./specs/vehicle.js";
import { NOTIFICATION_SPECS } from "./specs/notification.js";
import { PERSON_EMAIL_SPECS } from "./specs/person-email.js";
import { SIJAINTI_SPECS } from "./specs/sijainti.js";
import { OHJE_SPECS } from "./specs/ohje.js";
import { LEGAL_SPECS } from "./specs/legal.js";
import { SCHEDULE_SPECS } from "./specs/schedule.js";
import { LIFECYCLE_SPECS } from "./specs/lifecycle.js";
import { JERRY_SPECS } from "./specs/jerry.js";
import { DEV_SCHEMA_SPECS } from "./specs/dev-schema.js";
import { OPENDATA_SPECS } from "./specs/opendata.js";
import { REFERENCE_SPECS } from "./specs/reference.js";
import { DEV_META_SPECS } from "./specs/dev-meta.js";
import { DEV_FEEDBACK_SPECS } from "./specs/dev-feedback.js";
import { DEV_AI_CACHE_PERF_SPECS } from "./specs/dev-ai-cache-perf.js";
import { LOG_SPECS } from "./specs/log.js";
import { HELP_SEARCH_SPECS } from "./specs/help-search.js";
import { MESSAGE_SPECS } from "./specs/message.js";
import { GLOSSARY_SPECS } from "./specs/glossary.js";
import { TASK_SPECS } from "./specs/task.js";
import { SALES_SPECS } from "./specs/sales.js";

export { COMMON_AUTH_ERRORS } from "./specs/shared.js";
import { canonicalPath } from "./aliasPaths.js";

/**
 * The spec whose command equals the CANONICAL form of `path` (pass the path as
 * invoked — a back-compat alias resolves to the command's own spec, so aliased
 * invocations still get their documented remedies/allowed values). One lookup
 * shared by program.ts and unknownCommand.ts so alias resolution cannot drift
 * between the four sites that used to spell it inline.
 */
export function specForPath(path: string): CommandSpec | undefined {
  const canonical = canonicalPath(path);
  return COMMAND_SPECS.find((s) => s.command === canonical);
}

/**
 * The canonical catalogue of every `ib` subcommand. Summaries and details are
 * DB-served via `/api/cli/command-catalog` (`ib reference detail get`).
 */
export const COMMAND_SPECS: CommandSpec[] = [
  ...ATTACHMENT_SPECS,
  ...AUTH_SPECS,
  ...COMPANY_SPECS,
  ...KEIKKA_SPECS,
  ...CUSTOMER_SPECS,
  ...WORKSITE_SPECS,
  ...PERSON_SPECS,
  ...VEHICLE_SPECS,
  ...NOTIFICATION_SPECS,
  ...PERSON_EMAIL_SPECS,
  ...SIJAINTI_SPECS,
  ...OHJE_SPECS,
  ...LEGAL_SPECS,
  ...SCHEDULE_SPECS,
  ...LIFECYCLE_SPECS,
  ...JERRY_SPECS,
  ...DEV_SCHEMA_SPECS,
  ...OPENDATA_SPECS,
  ...REFERENCE_SPECS,
  ...DEV_META_SPECS,
  ...DEV_FEEDBACK_SPECS,
  ...DEV_AI_CACHE_PERF_SPECS,
  ...LOG_SPECS,
  ...HELP_SEARCH_SPECS,
  ...MESSAGE_SPECS,
  ...MESSAGE_DAILY_SPECS,
  ...MESSAGE_BOARD_SPECS,
  ...CHANGELOG_SPECS,
  ...GLOSSARY_SPECS,
  ...TASK_SPECS,
  ...SALES_SPECS,
];
