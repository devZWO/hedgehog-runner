/** Pure preflight. Embedded in the reusable workflow; never executes caller code. */
export function selectionRequest({ eventName, repository, authorId, headRepository, ownerId, labels, fallback = 'ubuntu-latest' }) {
    const validFallback = typeof fallback === 'string' && /^(?:ubuntu|windows|macos)-[a-z\d][a-z\d.-]*$/i.test(fallback);
    const request = { eligible: false, labels: [], fallback: validFallback ? fallback : 'ubuntu-latest', reason: '' };
    if (!validFallback) return { ...request, reason: 'Invalid hosted fallback; using ubuntu-latest.' };
    let parsed;
    try { parsed = typeof labels === 'string' ? JSON.parse(labels) : labels; } catch { /* Fail closed below. */ }
    if (!Array.isArray(parsed) || !parsed.length || parsed.some((label) => typeof label !== 'string'
        || !/^[a-z\d][a-z\d_.-]{0,62}$/i.test(label))
        || new Set(parsed.map((label) => label.toLowerCase())).size !== parsed.length
        || !parsed.some((label) => label.toLowerCase() === 'self-hosted')) {
        return { ...request, reason: 'Invalid self-hosted runner labels; using hosted fallback.' };
    }
    request.labels = parsed;
    if (eventName !== 'pull_request') return { ...request, reason: 'Event is not pull_request.' };
    if (typeof repository !== 'string' || !/^[a-z\d][a-z\d-]*\/[a-z\d_.-]+$/i.test(repository)
        || headRepository !== repository) return { ...request, reason: 'PR does not originate in the caller repository.' };
    if (!/^[1-9]\d*$/.test(String(ownerId ?? '')) || !Number.isSafeInteger(Number(ownerId))) {
        return { ...request, reason: 'RUNNER_OWNER_ID is missing or invalid.' };
    }
    if (String(authorId) !== String(ownerId)) return { ...request, reason: 'PR author does not match RUNNER_OWNER_ID.' };
    return { ...request, eligible: true, reason: 'Same-repository owner PR is eligible for self-hosted selection.' };
}

/** API access is injected. Credentials never form part of selection inputs or results. */
export async function selectRunner(request, { credentialsAvailable, listRunners }) {
    const hosted = (reason) => ({ runsOn: request.fallback, reason });
    if (!request.eligible) return hosted(request.reason);
    if (!credentialsAvailable) return hosted('Runner-read credentials are unavailable; using hosted fallback.');
    try {
        const runners = await listRunners();
        if (!Array.isArray(runners)) return hosted('Invalid runner API response; using hosted fallback.');
        const available = runners.some((runner) => runner?.status === 'online' && runner.busy === false
            && Array.isArray(runner.labels) && request.labels.every((label) => runner.labels.some((entry) =>
                typeof entry?.name === 'string' && entry.name.toLowerCase() === label.toLowerCase())));
        return available
            ? { runsOn: request.labels, reason: 'An online, idle runner has all required labels.' }
            : hosted('No online, idle runner has all required labels; using hosted fallback.');
    } catch {
        // Do not expose API errors, request headers or credentials in logs/outputs.
        return hosted('Runner availability query failed; using hosted fallback.');
    }
}
