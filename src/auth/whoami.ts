import type { CredentialsProfile } from "./store.js";

export interface WhoamiOutput {
  personId: number;
  activeCompany: { asiakasId: number; name: string };
  endpoint: string;
  /** Present only while an impersonation session is active. */
  impersonating?: { actorPersonId: number; sessionId: string };
}

/**
 * Project a credentials profile into the stable `whoami` JSON shape.
 *
 * Pure function — no I/O, no JWT decode. The caller loads the profile from disk.
 */
export function renderWhoami(creds: CredentialsProfile): WhoamiOutput {
  const out: WhoamiOutput = {
    personId: creds.personId,
    activeCompany: { asiakasId: creds.ownerAsiakasId, name: creds.ownerAsiakasName },
    endpoint: creds.endpoint,
  };
  if (creds.impersonation) out.impersonating = creds.impersonation;
  return out;
}
