import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { packageFiles } from '../scripts/check-package.mjs';

test('tagged release packaging preserves its verified workflow pin through npm pack and installation', () => {
    const original = fileURLToPath(new URL('../', import.meta.url));
    const temporary = mkdtempSync(join(tmpdir(), 'hedgehog-release-fixture-'));
    const root = join(temporary, 'source');
    const output = join(temporary, 'artifact');
    function run(command, args, env = process.env) {
        const result = spawnSync(command, args, { cwd: root, env, encoding: 'utf8' });
        assert.equal(result.status, 0, `${command}: ${result.stderr || result.stdout}`);
        return result.stdout;
    }
    try {
        const files = [...packageFiles.filter((path) => !path.startsWith('docs/')),
            '.gitignore', 'package-lock.json', '.github/workflows/select-runner.yml',
            'scripts/prepare-package.mjs', 'scripts/check-package.mjs', 'scripts/check-release.mjs'];
        for (const path of files) {
            mkdirSync(dirname(join(root, path)), { recursive: true });
            copyFileSync(join(original, path), join(root, path));
        }
        const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
        // A release simulation in /tmp; this does not date or publish the real changelog.
        writeFileSync(join(root, 'CHANGELOG.md'), `# Changelog\n\n## Release v${manifest.version} (2026-11-20)\n\nFixture only.\n`);
        run('git', ['init', '-q']);
        run('git', ['add', '.']);
        run('git', ['-c', 'user.name=Release Fixture', '-c', 'user.email=fixture@example.invalid',
            '-c', 'core.hooksPath=/dev/null', 'commit', '--no-gpg-sign', '-qm', 'Release fixture']);
        run('git', ['-c', 'tag.gpgSign=false', 'tag', `v${manifest.version}`]);
        const sha = run('git', ['rev-parse', 'HEAD']).trim();
        const env = { ...process.env, GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'release',
            GITHUB_REPOSITORY: 'devZWO/hedgehog-runner', GITHUB_SHA: sha,
            GITHUB_REF: `refs/tags/v${manifest.version}`, RELEASE_TAG: `v${manifest.version}`,
            RELEASE_PRERELEASE: manifest.version.includes('-') ? 'true' : 'false', HEDGEHOG_PACKAGE_OUTPUT: output };
        run(process.execPath, ['scripts/check-release.mjs'], env);
        const result = run(process.execPath, ['scripts/check-package.mjs'], env);
        assert.match(result, /Package check passed: 13 reviewed files/);
        const metadata = JSON.parse(readFileSync(join(root, 'docs/package-info.json'), 'utf8'));
        assert.equal(metadata.release, true);
        assert.equal(metadata.workflow.commit, sha);
        assert.match(readFileSync(join(output, 'SHA256SUMS'), 'utf8'), /^[a-f\d]{64}  .+\.tgz\n$/);
    } finally { rmSync(temporary, { recursive: true, force: true }); }
});
