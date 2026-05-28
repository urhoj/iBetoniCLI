export interface SwitchOptions {
  endpoint: string;
  jwt: string;
  toAsiakasId: number;
}

export interface SwitchResult {
  jwt: string;
  ownerAsiakasId: number;
  ownerAsiakasName: string;
}

interface SwitchResponseBody {
  token: string;
  ownerAsiakasId: number;
  ownerAsiakasName: string;
}

/**
 * Switch the active company by POSTing the target `asiakasId` to
 * `/api/company-selection/switch`. The backend re-issues a JWT bound to
 * the new tenant; the caller must persist the new token and updated
 * owner identity in the credentials store.
 */
export async function performSwitch(opts: SwitchOptions): Promise<SwitchResult> {
  const res = await fetch(`${opts.endpoint}/api/company-selection/switch`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${opts.jwt}`,
    },
    body: JSON.stringify({ asiakasId: opts.toAsiakasId }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(
      `Company switch failed: HTTP ${res.status}${detail ? ` ${detail}` : ""}`
    );
  }
  const body = (await res.json()) as SwitchResponseBody;
  return {
    jwt: body.token,
    ownerAsiakasId: body.ownerAsiakasId,
    ownerAsiakasName: body.ownerAsiakasName,
  };
}
