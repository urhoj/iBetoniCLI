export class CliError extends Error {
  constructor(
    message: string,
    public statusCode: number,
    public body: unknown,
    public exitCode: number
  ) {
    super(message);
    this.name = "CliError";
  }
}

export function exitCodeFromStatus(status: number): number {
  if (status === 401) return 2;
  if (status === 403) return 3;
  if (status === 404) return 5;
  if (status >= 400 && status < 500) return 4;
  if (status >= 500) return 6;
  return 1;
}
