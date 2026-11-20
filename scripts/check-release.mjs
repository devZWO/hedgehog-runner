import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function validateRelease({ manifest, lockfile, changelog, tag, prerelease }) {
    const version = manifest.version;
    const identifier = '(?:0|[1-9]\\d*|\\d*[a-zA-Z-][a-zA-Z\\d-]*)';
    const semver = new RegExp(`^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-${identifier}(?:\\.${identifier})*)?$`);
    if (!semver.test(version)) throw new Error('Package version must be an exact SemVer without build metadata.');
    if (tag !== `v${version}`) throw new Error(`Release tag must be v${version}; received ${tag || '(missing)'}.`);
    if (!['true', 'false'].includes(prerelease)) throw new Error('Release prerelease flag must be true or false.');
    if (version.includes('-') !== (prerelease === 'true')) throw new Error('GitHub prerelease flag must agree with the package prerelease version.');
    if (lockfile.version !== version || lockfile.packages?.['']?.version !== version) throw new Error('package-lock.json version must match package.json.');
    const heading = changelog.split('\n').find((line) => line.startsWith(`## Release v${version} (`));
    const date = heading?.match(/\((\d{4}-\d{2}-\d{2})\)$/)?.[1];
    if (!date || Number.isNaN(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) {
        throw new Error(`CHANGELOG.md needs a dated "## Release v${version} (YYYY-MM-DD)" section before publishing.`);
    }
    return prerelease === 'true' ? 'next' : 'latest';
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        const root = fileURLToPath(new URL('../', import.meta.url));
        const json = (path) => JSON.parse(readFileSync(resolve(root, path), 'utf8'));
        const distTag = validateRelease({ manifest: json('package.json'), lockfile: json('package-lock.json'),
            changelog: readFileSync(resolve(root, 'CHANGELOG.md'), 'utf8'),
            tag: process.env.RELEASE_TAG, prerelease: process.env.RELEASE_PRERELEASE });
        const state = spawnSync('git', ['status', '--porcelain', '--untracked-files=normal'], { cwd: root, encoding: 'utf8' });
        if (state.status !== 0 || state.stdout !== '') throw new Error('Release validation requires a clean Git checkout.');
        console.log(`Release checks passed; npm dist-tag: ${distTag}.`);
    } catch (error) { console.error(error.message); process.exitCode = 1; }
}
