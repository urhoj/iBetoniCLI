export class CliError extends Error {
    statusCode;
    body;
    exitCode;
    constructor(message, statusCode, body, exitCode) {
        super(message);
        this.statusCode = statusCode;
        this.body = body;
        this.exitCode = exitCode;
        this.name = "CliError";
    }
}
export function exitCodeFromStatus(status) {
    if (status === 401)
        return 2;
    if (status === 403)
        return 3;
    if (status === 404)
        return 5;
    if (status >= 400 && status < 500)
        return 4;
    if (status >= 500)
        return 6;
    return 1;
}
//# sourceMappingURL=errors.js.map