/**
 * `Promise.all` for a pair of independent reads, with SEQUENTIAL error
 * precedence preserved.
 *
 * Several commands issue two reads that don't depend on each other (a lookup
 * table + the row, a record + a registry hit). Running them concurrently halves
 * the latency, but a bare `Promise.all` also changes which error a caller sees
 * when BOTH reject: it surfaces whichever lost the race, where the `await a;
 * await b;` it replaced always surfaced `a`. That is reachable from one typo —
 * `ib legal accept <bad-type>` 404s the document read AND fails the type
 * resolution — and this CLI's errors are a machine-parseable contract, so the
 * message must not depend on which response landed first.
 *
 * `allSettled` also guarantees both rejections are handled, which a
 * fail-fast `Promise.all` (or awaiting the two promises in sequence) does not:
 * an unobserved rejection is a hard process error on modern Node.
 */
export async function bothInOrder(first, second) {
    const [a, b] = await Promise.allSettled([first, second]);
    if (a.status === "rejected")
        throw a.reason;
    if (b.status === "rejected")
        throw b.reason;
    return [a.value, b.value];
}
//# sourceMappingURL=parallel.js.map