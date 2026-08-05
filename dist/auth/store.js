import { readFile, writeFile, unlink, mkdir, chmod } from "node:fs/promises";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
// Same-process read cache: one CLI invocation loads the credentials file from
// several places (tier resolution in bin/ib.ts, then every CLI context), and an
// invocation never races an external writer — so the parsed file is cached per
// path and kept in sync by this module's own save/remove/clear.
const fileCache = new Map();
async function readCredentialsFile(path) {
    const cached = fileCache.get(path);
    if (cached !== undefined)
        return cached;
    if (!existsSync(path)) {
        fileCache.set(path, null);
        return null;
    }
    // A corrupt file throws out of JSON.parse (the documented load() contract)
    // and is deliberately NOT cached, so a repaired file re-reads.
    const parsed = JSON.parse(await readFile(path, "utf8"));
    fileCache.set(path, parsed);
    return parsed;
}
export function createStore(path) {
    return {
        async load(profile = "default") {
            const parsed = await readCredentialsFile(path);
            return parsed?.profiles?.[profile] ?? null;
        },
        async save(creds, profile = "default") {
            let existing = {
                schemaVersion: 1,
                profiles: {},
                activeProfile: "default",
            };
            if (existsSync(path)) {
                try {
                    existing = JSON.parse(await readFile(path, "utf8"));
                }
                catch {
                    // corrupt file; overwrite
                }
            }
            existing.profiles = { ...existing.profiles, [profile]: creds };
            existing.activeProfile = profile;
            await mkdir(dirname(path), { recursive: true });
            await writeFile(path, JSON.stringify(existing, null, 2), { mode: 0o600 });
            fileCache.set(path, existing);
            if (process.platform !== "win32") {
                await chmod(path, 0o600);
            }
        },
        async clear() {
            if (existsSync(path))
                await unlink(path);
            fileCache.set(path, null);
        },
        async remove(profile) {
            if (!existsSync(path))
                return;
            let file;
            try {
                file = JSON.parse(await readFile(path, "utf8"));
            }
            catch {
                return; // corrupt — nothing to remove
            }
            if (file.profiles)
                delete file.profiles[profile];
            if (file.activeProfile === profile)
                file.activeProfile = "default";
            await writeFile(path, JSON.stringify(file, null, 2), { mode: 0o600 });
            fileCache.set(path, file);
            if (process.platform !== "win32") {
                await chmod(path, 0o600);
            }
        },
    };
}
export function defaultCredentialsPath() {
    const home = process.env.HOME || process.env.USERPROFILE || ".";
    return join(home, ".ibetoni", "credentials.json");
}
//# sourceMappingURL=store.js.map