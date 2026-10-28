import { createRequire } from "node:module";
import { addWriteFlagsToCommand, writeFlagsToHeaders } from "../../api/writeFlags.js";
import { diffFields } from "../../diff.js";
import { failWith } from "../../output/json.js";
import { intFlag, resolvePersonTarget } from "../../targets.js";
import { jsonAction } from "../_shared/action.js";
/** personSettings NOTIFY_DAILY_CONFIRMED (34, boolVar), reused as "push me tomorrow's orders at 20". */
export const DRIVER_DAY_PUSH_TYPE_ID = createRequire(import.meta.url)("@ibetoni/constants").PERSON_SETTING_TYPE_IDS.NOTIFY_DAILY_CONFIRMED;
/** GET /api/person/setting/get/:personId/34 → { personId, enabled } (no row = off). */
export async function runDriverDayPushGet(client, personId) {
    const rows = await client.get(`/api/person/setting/get/${personId}/${DRIVER_DAY_PUSH_TYPE_ID}`);
    return { personId, enabled: !!rows?.[0]?.boolVar };
}
/**
 * POST /api/person/settings/set, the body the profile switch posts. --dry-run resolves client-side:
 * the route has no X-Dry-Run guard, so it GETs the current value and reports the diff without POSTing.
 */
export async function runDriverDayPushSet(client, personId, enabled, flags) {
    if (flags.dryRun) {
        const current = await runDriverDayPushGet(client, personId);
        return { dryRun: true, personId, wouldChange: diffFields(current, { enabled }, ["enabled"]) };
    }
    return client.post("/api/person/settings/set", { personId, personSettingTypeId: DRIVER_DAY_PUSH_TYPE_ID, boolVar: enabled, intVar: 0, stringVar: "" }, { headers: writeFlagsToHeaders(flags) });
}
/** Register `ib person driver-day-push get|set`. Specs: src/reference/specs/person.ts. */
export function registerPersonDriverDayPushCommands(parent, getClient) {
    const group = parent
        .command("driver-day-push")
        .description("Read/set the driver's 20:00 push of tomorrow's orders (personSettings 34)");
    group
        .command("get [personId]")
        .option("--person <id>", "", intFlag("--person", 1))
        .action(jsonAction(getClient, (client, idStr, opts) => runDriverDayPushGet(client, resolvePersonTarget(idStr, opts.person))));
    addWriteFlagsToCommand(group
        .command("set [personId]")
        .option("--person <id>", "", intFlag("--person", 1))
        .option("--on")
        .option("--off")).action(jsonAction(getClient, (client, idStr, opts) => {
        const personId = resolvePersonTarget(idStr, opts.person);
        if (!!opts.on === !!opts.off)
            failWith("pass exactly one of --on or --off", 4);
        return runDriverDayPushSet(client, personId, !!opts.on, opts);
    }));
}
//# sourceMappingURL=driverDayPush.js.map