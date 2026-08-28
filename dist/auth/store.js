import { readFile, writeFile, unlink, mkdir, chmod } from "node:fs/promises";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { withFileLock } from "./lock.js";
export const ACTIVE_PROFILE = "default";
/** The slot an endpoint's session lives under: host[:port], case-folded — scheme and path never distinguish a session. */
export function endpointKey(endpoint) {
    try {
        return new URL(endpoint).host.toLowerCase();
    }
    catch {
        return endpoint.trim().toLowerCase();
    }
}
// Same-process read cache: one CLI invocation loads the credentials file from
// several places (tier resolution in bin/ib.ts, then every CLI context), and an
// invocation almost never races an external writer — so the parsed file is
// cached per path and kept in sync by this module's own save/remove/clear.
// The ONE place that races by nature — the token refresh path (fb#884) — reads
// through reload() instead, which busts this cache first.
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
async function writeCredentialsFile(path, file) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(file, null, 2), { mode: 0o600 });
    fileCache.set(path, file);
    if (process.platform !== "win32") {
        await chmod(path, 0o600);
    }
}
/** Is the active session the one minted for this endpoint key? */
function activeIsFor(file, key) {
    const active = file?.profiles?.[ACTIVE_PROFILE];
    return !!active && endpointKey(active.endpoint) === key;
}
export function createStore(path) {
    const load = async (profile = ACTIVE_PROFILE) => {
        const parsed = await readCredentialsFile(path);
        return parsed?.profiles?.[profile] ?? null;
    };
    const loadFor = async (endpoint) => {
        const file = await readCredentialsFile(path);
        const key = endpointKey(endpoint);
        return (activeIsFor(file, key) ? file?.profiles[ACTIVE_PROFILE] : file?.profiles?.[key]) ?? null;
    };
    const clear = async () => {
        if (existsSync(path))
            await unlink(path);
        fileCache.set(path, null);
    };
    return {
        load,
        loadFor,
        async reload(profile = ACTIVE_PROFILE) {
            fileCache.delete(path);
            return load(profile);
        },
        async reloadFor(endpoint) {
            fileCache.delete(path);
            return loadFor(endpoint);
        },
        withLock(fn) {
            return withFileLock(`${path}.lock`, fn);
        },
        async save(creds, profile, opts) {
            let file = { schemaVersion: 1, profiles: {}, activeProfile: ACTIVE_PROFILE };
            try {
                // Read through the cache (an invocation typically loaded the file
                // already). Unlike `load`, a corrupt file is NOT fatal here — swallow
                // the parse throw and overwrite, as this path always has.
                file = (await readCredentialsFile(path)) ?? file;
            }
            catch {
                // corrupt file; overwrite
            }
            file.profiles = { ...file.profiles };
            const key = endpointKey(creds.endpoint);
            const active = file.profiles[ACTIVE_PROFILE];
            if (profile !== undefined && profile !== ACTIVE_PROFILE) {
                file.profiles[profile] = creds;
            }
            else if (opts?.activate || !active || endpointKey(active.endpoint) === key) {
                // Becomes (or stays) the active session; a previous active session
                // for ANOTHER endpoint is parked, never lost.
                if (active && endpointKey(active.endpoint) !== key)
                    file.profiles[endpointKey(active.endpoint)] = active;
                file.profiles[ACTIVE_PROFILE] = creds;
                delete file.profiles[key]; // one slot per endpoint
            }
            else {
                file.profiles[key] = creds;
            }
            await writeCredentialsFile(path, file);
        },
        async sessions() {
            const file = await readCredentialsFile(path);
            const profiles = file?.profiles ?? {};
            const active = profiles[ACTIVE_PROFILE];
            return [
                ...(active ? [{ ...active, active: true }] : []),
                ...Object.entries(profiles)
                    .filter(([k]) => k !== ACTIVE_PROFILE && !k.startsWith("_"))
                    .map(([, p]) => ({ ...p, active: false })),
            ];
        },
        clear,
        async remove(profile) {
            let file;
            try {
                file = await readCredentialsFile(path); // null when absent
            }
            catch {
                return; // corrupt — nothing to remove
            }
            if (!file)
                return;
            file.profiles = { ...file.profiles };
            delete file.profiles[profile];
            await writeCredentialsFile(path, file);
        },
        async removeEndpoint(endpoint) {
            let file;
            try {
                file = await readCredentialsFile(path);
            }
            catch {
                return; // corrupt — nothing to remove
            }
            if (!file)
                return;
            const key = endpointKey(endpoint);
            file.profiles = { ...file.profiles };
            if (activeIsFor(file, key))
                delete file.profiles[ACTIVE_PROFILE];
            delete file.profiles[key];
            if (Object.keys(file.profiles).length === 0)
                return clear();
            await writeCredentialsFile(path, file);
        },
    };
}
export function defaultCredentialsPath() {
    const home = process.env.HOME || process.env.USERPROFILE || ".";
    return join(home, ".ibetoni", "credentials.json");
}
//# sourceMappingURL=store.js.map