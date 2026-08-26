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

interface CredentialsFile {
  schemaVersion: 1;
  profiles: Record<string, CredentialsProfile>;
  activeProfile: string;
}

export interface CredentialsStore {
  load(profile?: string): Promise<CredentialsProfile | null>;
  /**
   * Read the profile FRESH from disk, bypassing the same-process cache.
   * For the locked refresh path (fb#884), where another process may have
   * rotated the credentials since this invocation first loaded them.
   */
  reload(profile?: string): Promise<CredentialsProfile | null>;
  save(creds: CredentialsProfile, profile?: string): Promise<void>;
  clear(): Promise<void>;
  remove(profile: string): Promise<void>;
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

export function createStore(path: string): CredentialsStore {
  const load = async (profile = "default"): Promise<CredentialsProfile | null> => {
    const parsed = await readCredentialsFile(path);
    return parsed?.profiles?.[profile] ?? null;
  };
  return {
    load,
    async reload(profile = "default"): Promise<CredentialsProfile | null> {
      fileCache.delete(path);
      return load(profile);
    },
    withLock<T>(fn: () => Promise<T>): Promise<T> {
      return withFileLock(`${path}.lock`, fn);
    },
    async save(creds: CredentialsProfile, profile = "default"): Promise<void> {
      let existing: CredentialsFile = {
        schemaVersion: 1,
        profiles: {},
        activeProfile: "default",
      };
      try {
        // Read through the cache (an invocation typically loaded the file
        // already). Unlike `load`, a corrupt file is NOT fatal here — swallow
        // the parse throw and overwrite, as this path always has.
        existing = (await readCredentialsFile(path)) ?? existing;
      } catch {
        // corrupt file; overwrite
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
    async clear(): Promise<void> {
      if (existsSync(path)) await unlink(path);
      fileCache.set(path, null);
    },
    async remove(profile: string): Promise<void> {
      let file: CredentialsFile | null;
      try {
        file = await readCredentialsFile(path); // null when absent
      } catch {
        return; // corrupt — nothing to remove
      }
      if (!file) return;
      if (file.profiles) delete file.profiles[profile];
      if (file.activeProfile === profile) file.activeProfile = "default";
      await writeFile(path, JSON.stringify(file, null, 2), { mode: 0o600 });
      fileCache.set(path, file);
      if (process.platform !== "win32") {
        await chmod(path, 0o600);
      }
    },
  };
}

export function defaultCredentialsPath(): string {
  const home = process.env.HOME || process.env.USERPROFILE || ".";
  return join(home, ".ibetoni", "credentials.json");
}
