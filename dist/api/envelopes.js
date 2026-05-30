export function isListEnvelope(value) {
    return (!!value &&
        typeof value === "object" &&
        Array.isArray(value.items));
}
//# sourceMappingURL=envelopes.js.map