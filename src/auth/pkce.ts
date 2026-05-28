import { randomBytes, createHash } from "node:crypto";

export interface PkcePair {
  verifier: string;
  challenge: string;
  method: "S256";
}

export function generatePkcePair(): PkcePair {
  const verifier = randomBytes(48).toString("base64url"); // 64 chars in base64url
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge, method: "S256" };
}

export function generateState(): string {
  return randomBytes(32).toString("hex");
}
