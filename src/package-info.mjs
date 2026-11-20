import { readFileSync } from 'node:fs';

/** Read version-local release metadata; source checkouts need not have generated docs. */
export function packageInfo(root = new URL('../', import.meta.url)) {
    const manifest = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
    let metadata;
    try { metadata = JSON.parse(readFileSync(new URL('docs/package-info.json', root), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (metadata && (metadata.schemaVersion !== 1 || metadata.name !== manifest.name || metadata.version !== manifest.version)) {
        throw new Error('Bundled package metadata does not match the installed package version.');
    }
    const commit = metadata?.workflow?.commit;
    if (commit != null && !/^[a-f\d]{40}$/.test(commit)) throw new Error('Invalid bundled workflow commit SHA.');
    return { name: manifest.name, version: manifest.version, workflowCommit: commit ?? null };
}
