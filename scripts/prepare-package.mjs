import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Attach immutable release identity only to a clean official GitHub release checkout. */
export function packageMetadata({ manifest, workflow, head, clean, tagged, env }) {
    const commit = clean && /^[a-f\d]{40}$/.test(head ?? '') ? head : null;
    const release = Boolean(commit && tagged && env.GITHUB_ACTIONS === 'true'
        && env.GITHUB_EVENT_NAME === 'release' && env.GITHUB_REPOSITORY === 'devZWO/hedgehog-runner'
        && env.GITHUB_SHA === commit && env.GITHUB_REF === `refs/tags/v${manifest.version}`);
    return {
        schemaVersion: 1, name: manifest.name, version: manifest.version,
        sourceCommit: commit, release,
        workflow: {
            repository: 'devZWO/hedgehog-runner', path: '.github/workflows/select-runner.yml',
            commit: release ? commit : null,
            sha256: createHash('sha256').update(workflow).digest('hex'),
        },
    };
}

export function preparePackage(root = fileURLToPath(new URL('../', import.meta.url)), env = process.env) {
    const git = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
    const workflow = readFileSync(resolve(root, '.github/workflows/select-runner.yml'), 'utf8');
    const head = git('rev-parse', 'HEAD');
    const status = git('status', '--porcelain', '--untracked-files=normal');
    const committedWorkflow = git('show', 'HEAD:.github/workflows/select-runner.yml');
    const tag = git('rev-parse', `refs/tags/v${manifest.version}^{commit}`);
    const metadata = packageMetadata({ manifest, workflow, head: head.stdout?.trim(),
        clean: status.status === 0 && status.stdout === '' && committedWorkflow.status === 0 && committedWorkflow.stdout === workflow,
        tagged: tag.status === 0 && tag.stdout === head.stdout, env });
    mkdirSync(resolve(root, 'docs'), { recursive: true });
    writeFileSync(resolve(root, 'docs/select-runner.yml'), workflow);
    writeFileSync(resolve(root, 'docs/package-info.json'), `${JSON.stringify(metadata, null, 2)}\n`);
    return metadata;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) preparePackage();
