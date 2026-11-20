import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { parseDocument } from 'yaml';
import { auditPackageFiles, packageFiles } from '../scripts/check-package.mjs';
import { packageMetadata } from '../scripts/prepare-package.mjs';
import { validateRelease } from '../scripts/check-release.mjs';
import { packageInfo } from '../src/package-info.mjs';
import { workflowExample } from '../src/workflow.mjs';

const sha = 'a'.repeat(40);
const manifest = { name: '@devzwo/hedgehog-runner', version: '0.1.0' };
const releaseInput = { manifest, workflow: 'selector contents\n', head: sha, clean: true, tagged: true,
    env: { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'release', GITHUB_REPOSITORY: 'devZWO/hedgehog-runner',
        GITHUB_SHA: sha, GITHUB_REF: 'refs/tags/v0.1.0' } };

test('archive audit rejects missing runtime/docs and any unreviewed development or credential files', () => {
    auditPackageFiles(packageFiles);
    for (const path of packageFiles) assert.throws(() => auditPackageFiles(packageFiles.filter((entry) => entry !== path)), /exactly the reviewed/);
    for (const path of ['src/selection.mjs', 'test/runner.test.mjs', 'AGENTS.md', 'CONTRIBUTING.md', '.env', '.runner', 'node_modules/yaml/package.json']) {
        assert.throws(() => auditPackageFiles([...packageFiles, path]), /exactly the reviewed/);
    }
});

test('only clean official tagged release builds receive a default published selector pin', () => {
    const metadata = packageMetadata(releaseInput);
    assert.equal(metadata.release, true);
    assert.equal(metadata.workflow.commit, sha);
    assert.equal(metadata.version, manifest.version);
    assert.equal(metadata.workflow.sha256.length, 64);
    assert.deepEqual(metadata, packageMetadata(releaseInput), 'Metadata must not contain a build timestamp');
    for (const input of [
        { ...releaseInput, clean: false }, { ...releaseInput, tagged: false }, { ...releaseInput, head: '' },
        { ...releaseInput, env: {} },
        ...['GITHUB_ACTIONS', 'GITHUB_EVENT_NAME', 'GITHUB_REPOSITORY', 'GITHUB_SHA', 'GITHUB_REF'].map((key) => ({
            ...releaseInput, env: { ...releaseInput.env, [key]: 'different' },
        })),
    ]) {
        const development = packageMetadata(input);
        assert.equal(development.release, false);
        assert.equal(development.workflow.commit, null);
    }
    const content = workflowExample({ repository: 'example/project', labels: ['laptop'] }, { publishedRef: metadata.workflow.commit });
    assert.match(content, new RegExp(`@${sha}`));
    assert.doesNotMatch(content, /TEMPLATE ONLY/);
});

test('installed package metadata must match the manifest and contain a valid release pin', () => {
    const directory = mkdtempSync(join(tmpdir(), 'hedgehog-metadata-'));
    const root = pathToFileURL(`${directory}/`);
    try {
        writeFileSync(join(directory, 'package.json'), JSON.stringify(manifest));
        assert.deepEqual(packageInfo(root), { ...manifest, workflowCommit: null });
        mkdirSync(join(directory, 'docs'));
        const path = join(directory, 'docs/package-info.json');
        writeFileSync(path, JSON.stringify(packageMetadata(releaseInput)));
        assert.deepEqual(packageInfo(root), { ...manifest, workflowCommit: sha });
        writeFileSync(path, JSON.stringify({ ...packageMetadata(releaseInput), version: '0.2.0' }));
        assert.throws(() => packageInfo(root), /does not match/);
        writeFileSync(path, JSON.stringify({ ...packageMetadata(releaseInput), workflow: { commit: 'main' } }));
        assert.throws(() => packageInfo(root), /Invalid bundled/);
    } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('release checks enforce tag/version/lockfile/changelog and stable versus prerelease dist-tags', () => {
    const input = { manifest, lockfile: { version: '0.1.0', packages: { '': { version: '0.1.0' } } },
        changelog: '# Changelog\n\n## Release v0.1.0 (2026-11-20)\n', tag: 'v0.1.0', prerelease: 'false' };
    assert.equal(validateRelease(input), 'latest');
    assert.equal(validateRelease({ ...input, manifest: { ...manifest, version: '0.2.0-beta.1' },
        lockfile: { version: '0.2.0-beta.1', packages: { '': { version: '0.2.0-beta.1' } } },
        changelog: '## Release v0.2.0-beta.1 (2026-11-20)\n', tag: 'v0.2.0-beta.1', prerelease: 'true' }), 'next');
    for (const [changes, message] of [
        [{ tag: 'v0.2.0' }, /Release tag/], [{ prerelease: 'true' }, /prerelease flag/],
        [{ prerelease: '' }, /flag must be/], [{ lockfile: { version: '0.2.0' } }, /lock/],
        [{ changelog: '## Unreleased\n' }, /dated/],
        [{ changelog: '## Release v0.1.0 (2026-02-30)\n' }, /dated/],
        [{ manifest: { ...manifest, version: '01.0.0' } }, /SemVer/],
    ]) assert.throws(() => validateRelease({ ...input, ...changes }), message);
});

test('publication uses protected OIDC job and the exact validated tarball, without rebuild or npm token', () => {
    const path = new URL('../.github/workflows/publish.yml', import.meta.url);
    const document = parseDocument(readFileSync(path, 'utf8'));
    assert.deepEqual(document.errors, []);
    const workflow = document.toJS();
    assert.deepEqual(workflow.on.release.types, ['published']);
    assert.equal(workflow.concurrency['cancel-in-progress'], false);
    assert.equal(workflow.jobs.validate.uses, './.github/workflows/ci.yml');
    assert.equal(workflow.jobs.validate.with['upload-package'], true);
    const publish = workflow.jobs.publish;
    assert.equal(publish.needs, 'validate');
    assert.equal(publish.environment, 'npm');
    assert.equal(publish.permissions['id-token'], 'write');
    assert.equal(workflow.permissions['id-token'], undefined);
    assert.ok(publish.steps.some((step) => step.with?.name === 'npm-package'));
    const script = publish.steps.find((step) => step.run)?.run;
    assert.match(script, /sha256sum --check SHA256SUMS/);
    assert.match(script, /npm publish "\$1" --ignore-scripts --access public --provenance/);
    assert.doesNotMatch(JSON.stringify(publish), /NPM_TOKEN|NODE_AUTH_TOKEN|checkout|npm ci|npm pack/);
    for (const step of publish.steps.filter((step) => step.uses)) assert.match(step.uses, /@v\d+$/);
    const validation = parseDocument(readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')).toJS();
    for (const step of validation.jobs['test-and-package'].steps.filter((step) => step.uses)) {
        assert.match(step.uses, /@v\d+$/, 'Own build and publishing workflows use readable major-version tags');
    }
});
