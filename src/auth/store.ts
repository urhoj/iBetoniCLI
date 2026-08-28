import { readFile, writeFile, unlink, mkdir, chmod } from "node:fs/promises";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { withFileLock } from "./lock.js";

export interface CredentialsProfile {
  jwt: string;
  refreshToken: string;
  issuedAt: string;
  expiresAt: string;
  personId: number;
  ownerAsiakasId: number;
  ownerAsiakasName: string;
  endpoint: string;
  /** Present only when this profile is an active impersonation session. */
  impersonation?: { actorPersonId: number; sessionId: string };
}

/**
 * On disk. `profiles.default` is the ACTIVE session — the one a bare `ib …`
 * (no `--endpoint`) acts with. Every OTHER endpoint's session is PARKED under
 * its host key (`api.ibetoni.fi`, `127.0.0.1:8080`), so a prod login and a
 * local-dev login coexist and `--endpoint` selects between them (fb#855: a
 * token is endpoint-specific, and one slot meant every switch was a re-login
 * and every mismatch a 401 with a wall of remediation text). Each endpoint's
 * session lives in exactly ONE slot. Underscore-prefixed profiles
 * (`_impersonator`) are internal stashes, not sessions. `activeProfile` is a
 * legacy field nothing reads; it stays "default".
 */
interface CredentialsFile {
  schemaVersion: 1;
  profiles: Record<string, CredentialsProfile>;
  activeProfile: string;
}

export const ACTIVE_PROFILE = "default";

/** The slot an endpoint's session lives under: host[:port], case-folded — scheme and path never distinguish a session. */
export function endpointKey(endpoint: string): string {
  try {
    return new URL(endpoint).host.toLowerCase();
  } catch {
    return endpoint.trim().toLowerCase();
  }
}

export interface StoredSession extends CredentialsProfile {
  active: boolean;
}

export interface CredentialsStore {
  load(profile?: string): Promise<CredentialsProfile | null>;
  /**
   * Read the profile FRESH from disk, bypassing the same-process cache.
   * For the locked refresh path (fb#884), where another process may have
   * rotated the credentials since this invocation first loaded them.
   */
  reload(profile?: string): Promise<CredentialsProfile | null>;
  /** The session minted for `endpoint` — active or parked — or null when there is none. */
  loadFor(endpoint: string): Promise<CredentialsProfile | null>;
  /** {@link loadFor}, fresh from disk — the refresh path's read. */
  reloadFor(endpoint: string): Promise<CredentialsProfile | null>;
  /**
   * Persist a session. An explicit `profile` names a slot outright (the
   * impersonator stash). Otherwise the slot follows the ENDPOINT: the active
   * slot when the session is for the active endpoint (or nothing is active
   * yet), else the endpoint's parked slot — so a refresh under
   * `--endpoint <other>` never hijacks the default. `activate` (login,
   * impersonation) makes it the active session outright, parking whatever
   * was active for another endpoint.
   */
  save(creds: CredentialsProfile, profile?: string, opts?: { activate?: boolean }): Promise<void>;
  /** Every stored session, active first; stashes excluded. */
  sessions(): Promise<StoredSession[]>;
  clear(): Promise<void>;
  remove(profile: string): Promise<void>;
  /** Forget one endpoint's session, active or parked; the file goes with the last one. */
  removeEndpoint(endpoint: string): Promise<void>;
  /**
   * Serialize a critical section against OTHER PROCESSES sharing this
   * credentials file (fb#884: the rotating-refresh-token race). Best-effort —
   * see lock.ts; `fn` always runs.
   */
  withLock<T>(fn: () => Promise<T>): Promise<T>;
}

// Same-process read cache: one CLI invocation loads the credentials file from
// several places (tier resolution in bin/ib.ts, then every CLI context), and an
// invocation almost never races an external writer — so the parsed file is
// cached per path and kept in sync by this module's own save/remove/clear.
// The ONE place that races by nature — the token refresh path (fb#884) — reads
// through reload() instead, which busts this cache first.
const fileCache = new Map<string, CredentialsFile | null>();

async function readCredentialsFile(path: string): Promise<CredentialsFile | null> {
  const cached = fileCache.get(path);
  if (cached !== undefined) return cached;
  if (!existsSync(path)) {
    fileCache.set(path, null);
    return null;
  }
  // A corrupt file throws out of JSON.parse (the documented load() contract)
  // and is deliberately NOT cached, so a repaired file re-reads.
  const parsed = JSON.parse(await readFile(path, "utf8")) as CredentialsFile;
  fileCache.set(path, parsed);
  return parsed;
}

async function writeCredentialsFile(path: string, file: CredentialsFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(file, null, 2), { mode: 0o600 });
  fileCache.set(path, file);
  if (process.platform !== "win32") {
    await chmod(path, 0o600);
  }
}

/** Is the active session the one minted for this endpoint key? */
function activeIsFor(file: CredentialsFile | null, key: string): boolean {
  const active = file?.profiles?.[ACTIVE_PROFILE];
  return !!active && endpointKey(active.endpoint) === key;
}

export function createStore(path: string): CredentialsStore {
  const load = async (profile = ACTIVE_PROFILE): Promise<CredentialsProfile | null> => {
    const parsed = await readCredentialsFile(path);
    return parsed?.profiles?.[profile] ?? null;
  };
  const loadFor = async (endpoint: string): Promise<CredentialsProfile | null> => {
    const file = await readCredentialsFile(path);
    const key = endpointKey(endpoint);
    return (activeIsFor(file, key) ? file?.profiles[ACTIVE_PROFILE] : file?.profiles?.[key]) ?? null;
  };
  const clear = async (): Promise<void> => {
    if (existsSync(path)) await unlink(path);
    fileCache.set(path, null);
  };
  return {
    load,
    loadFor,
    async reload(profile = ACTIVE_PROFILE): Promise<CredentialsProfile | null> {
      fileCache.delete(path);
      return load(profile);
    },
    async reloadFor(endpoint: string): Promise<CredentialsProfile | null> {
      fileCache.delete(path);
      return loadFor(endpoint);
    },
    withLock<T>(fn: () => Promise<T>): Promise<T> {
      return withFileLock(`${path}.lock`, fn);
    },
    async save(creds, profile, opts): Promise<void> {
      let file: CredentialsFile = { schemaVersion: 1, profiles: {}, activeProfile: ACTIVE_PROFILE };
      try {
        // Read through the cache (an invocation typically loaded the file
        // already). Unlike `load`, a corrupt file is NOT fatal here — swallow
        // the parse throw and overwrite, as this path always has.
        file = (await readCredentialsFile(path)) ?? file;
      } catch {
        // corrupt file; overwrite
      }
      file.profiles = { ...file.profiles };
      const key = endpointKey(creds.endpoint);
      const active = file.profiles[ACTIVE_PROFILE];
      if (profile !== undefined && profile !== ACTIVE_PROFILE) {
        file.profiles[profile] = creds;
      } else if (opts?.activate || !active || endpointKey(active.endpoint) === key) {
        // Becomes (or stays) the active session; a previous active session
        // for ANOTHER endpoint is parked, never lost.
        if (active && endpointKey(active.endpoint) !== key) file.profiles[endpointKey(active.endpoint)] = active;
        file.profiles[ACTIVE_PROFILE] = creds;
        delete file.profiles[key]; // one slot per endpoint
      } else {
        file.profiles[key] = creds;
      }
      await writeCredentialsFile(path, file);
    },
    async sessions(): Promise<StoredSession[]> {
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
    async remove(profile: string): Promise<void> {
      let file: CredentialsFile | null;
      try {
        file = await readCredentialsFile(path); // null when absent
      } catch {
        return; // corrupt — nothing to remove
      }
      if (!file) return;
      file.profiles = { ...file.profiles };
      delete file.profiles[profile];
      await writeCredentialsFile(path, file);
    },
    async removeEndpoint(endpoint: string): Promise<void> {
      let file: CredentialsFile | null;
      try {
        file = await readCredentialsFile(path);
      } catch {
        return; // corrupt — nothing to remove
      }
      if (!file) return;
      const key = endpointKey(endpoint);
      file.profiles = { ...file.profiles };
      if (activeIsFor(file, key)) delete file.profiles[ACTIVE_PROFILE];
      delete file.profiles[key];
      if (Object.keys(file.profiles).length === 0) return clear();
      await writeCredentialsFile(path, file);
    },
  };
}

export function defaultCredentialsPath(): string {
  const home = process.env.HOME || process.env.USERPROFILE || ".";
  return join(home, ".ibetoni", "credentials.json");
}
