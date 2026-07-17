/**
 * Ambient "which ib command is running" holder + the Commander-chain path
 * helper. Set once per invocation by the entry points (bin/ib.ts, runArgv.ts)
 * in their preAction hooks; read by the API client (buildHeaders) to attach
 * the X-Ib-Command header — the backend batches these into the /systemmap
 * live-activity socket stream (ibActivity:batch).
 *
 * COMMAND NAMES ONLY: the value is derived from Commander command names,
 * never positionals or flag values, so no user data can leak into the header.
 * Module-global like the ambient tier (same interleave caveat — see the
 * runArgv.ts comment on setCallerTier).
 */
export interface NamedCommand {
  name(): string;
  parent?: NamedCommand | null;
}

/** Commander chain -> "dev feedback get" (root program name excluded). */
export function commandPathOf(cmd: NamedCommand | null | undefined): string {
  const names: string[] = [];
  let c: NamedCommand | null | undefined = cmd;
  while (c && c.parent) {
    names.unshift(c.name());
    c = c.parent;
  }
  return names.join(" ");
}

let ambientCommandPath: string | null = null;

export function setAmbientCommandPath(path: string | null): void {
  ambientCommandPath = path || null;
}

export function getAmbientCommandPath(): string | null {
  return ambientCommandPath;
}
