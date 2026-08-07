import { addWriteFlagsToCommand, } from "../../api/writeFlags.js";
import { writeJson } from "../../output/json.js";
import { guarded } from "./action.js";
/**
 * Register the `add` + `remove` leaves of one entity↔person link group.
 *
 * Both are lifecycle writes, so `--reason` is mandatory (no `--dry-run`
 * exemption) — the link change lands in changeTracker and an unexplained
 * membership edit is exactly what the audit trail exists to catch. The
 * requirement is spec-declared (`reasonPolicy: "always"` on all four
 * person-link specs) and enforced centrally by the preAction hook.
 */
export function registerPersonLinkCommands(parent, getClient, cfg) {
    const register = (name, run) => {
        addWriteFlagsToCommand(parent
            .command(name)
            .requiredOption(`--${cfg.targetFlag} <id>`, cfg.targetDescription, Number)
            .requiredOption("--person <id>", "Target personId", Number)
            .option("--contact-type <id>", cfg.contactTypeDescription, Number, 1)).action(guarded(async (opts) => {
            const client = await getClient();
            writeJson(await run(client, {
                [cfg.targetField]: opts[cfg.targetFlag],
                personId: opts.person,
                contactPersonTypeId: opts.contactType,
            }, opts));
        }));
    };
    register("add", cfg.add);
    register("remove", cfg.remove);
}
//# sourceMappingURL=personLink.js.map