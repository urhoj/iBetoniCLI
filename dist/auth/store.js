import { readFile, writeFile, unlink, mkdir, chmod } from "node:fs/promises";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
export function createStore(path) {
    return {
        async load(profile = "default") {
            if (!existsSync(path))
                return null;
            const raw = await readFile(path, "utf8");
            const parsed = JSON.parse(raw);
            return parsed.profiles?.[profile] ?? null;
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
            if (process.platform !== "win32") {
                await chmod(path, 0o600);
            }
        },
        async clear() {
            if (existsSync(path))
                await unlink(path);
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