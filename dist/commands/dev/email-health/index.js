import { jsonAction } from "../../_shared/action.js";
export async function runDevEmailHealth(client, opts = {}) {
    const qs = opts.days ? `?days=${encodeURIComponent(String(opts.days))}` : "";
    return client.get(`/api/email-health${qs}`);
}
export function registerEmailHealthCommand(parent, getClient) {
    parent
        .command("email-health")
        .description("Account-wide SendGrid sender health — volume, deferral rate, recipient concentration")
        .option("--days <n>", "Window in days (1..90, default 7)", Number)
        .action(jsonAction(getClient, (client, opts) => runDevEmailHealth(client, opts)));
}
//# sourceMappingURL=index.js.map