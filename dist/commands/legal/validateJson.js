/** The JSON candidate string: the first ```json fence if present, else the whole content. */
export function extractJsonCandidate(markdownContent) {
    const fenced = markdownContent.match(/```json\s*([\s\S]*?)```/i);
    return (fenced ? fenced[1] : markdownContent).trim();
}
export function validateStructuredJson(markdownContent) {
    if (typeof markdownContent !== "string" || !markdownContent.trim()) {
        return { ok: false, error: "content is empty — nothing to validate" };
    }
    const raw = extractJsonCandidate(markdownContent);
    if (!raw) {
        return { ok: false, error: "no ```json block found and content is not JSON" };
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch (e) {
        return { ok: false, error: `JSON does not parse: ${e.message}` };
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { ok: false, error: "JSON must be an object (the FE reads it as a key/value map)" };
    }
    return { ok: true };
}
//# sourceMappingURL=validateJson.js.map