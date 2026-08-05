import { readFile, writeFile, unlink, mkdir, chmod } from "node:fs/promises";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";

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
  save(creds: CredentialsProfile, profile?: string): Promise<void>;
  clear(): Promise<void>;
  remove(profile: string): Promise<void>;
}

// Same-process read cache: one CLI invocation loads the credentials file from
// several places (tier resolution in bin/ib.ts, then every CLI context), and an
// invocation never races an external writer — so the parsed file is cached per
// path and kept in sync by this module's own save/remove/clear.
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
  return {
    async load(profile = "default"): Promise<CredentialsProfile | null> {
      const parsed = await readCredentialsFile(path);
      return parsed?.profiles?.[profile] ?? null;
    },
    async save(creds: CredentialsProfile, profile = "default"): Promise<void> {
      let existing: CredentialsFile = {
        schemaVersion: 1,
        profiles: {},
        activeProfile: "default",
      };
      if (existsSync(path)) {
        try {
          existing = JSON.parse(await readFile(path, "utf8")) as CredentialsFile;
        } catch {
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
    async clear(): Promise<void> {
      if (existsSync(path)) await unlink(path);
      fileCache.set(path, null);
    },
    async remove(profile: string): Promise<void> {
      if (!existsSync(path)) return;
      let file: CredentialsFile;
      try {
        file = JSON.parse(await readFile(path, "utf8")) as CredentialsFile;
      } catch {
        return; // corrupt — nothing to remove
      }
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
