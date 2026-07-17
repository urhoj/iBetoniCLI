/** Commander chain -> "dev feedback get" (root program name excluded). */
export function commandPathOf(cmd) {
    const names = [];
    let c = cmd;
    while (c && c.parent) {
        names.unshift(c.name());
        c = c.parent;
    }
    return names.join(" ");
}
let ambientCommandPath = null;
export function setAmbientCommandPath(path) {
    ambientCommandPath = path || null;
}
export function getAmbientCommandPath() {
    return ambientCommandPath;
}
//# sourceMappingURL=commandContext.js.map