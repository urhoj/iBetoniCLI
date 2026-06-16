/**
 * The usage-feedback nudge appended to on-demand detail surfaces (`ib reference
 * detail` JSON `hint`, and the `--help` AI NOTES footer). When the AI reads a
 * command's business context and it's wrong/missing, this tells it exactly how
 * to report it — and the `--command "reference detail <path>"` marker makes the
 * filing SELF-IDENTIFYING so the optimize-ib-summaries skill (and only it) can
 * find and resolve those rows. Single-sourced so both surfaces stay in lockstep.
 */
export function feedbackHintFor(command) {
    const path = command.replace(/^ib /, "");
    return (`If this is wrong/misleading/incomplete, file: ib feedback create ` +
        `--scope cli --command "reference detail ${path}" -- "<what is off>"`);
}
//# sourceMappingURL=feedbackHint.js.map