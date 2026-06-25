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

export function createStore(path: string): CredentialsStore {
  return {
    async load(profile = "default"): Promise<CredentialsProfile | null> {
      if (!existsSync(path)) return null;
      const raw = await readFile(path, "utf8");
      const parsed = JSON.parse(raw) as CredentialsFile;
      return parsed.profiles?.[profile] ?? null;
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
      if (process.platform !== "win32") {
        await chmod(path, 0o600);
      }
    },
    async clear(): Promise<void> {
      if (existsSync(path)) await unlink(path);
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
