import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument, stringify } from 'yaml';
import { workflowExample } from '../src/workflow.mjs';

// Official v1.7.12 release asset digest, verified through GitHub's release API.
const version = '1.7.12';
const digest = '8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8';
const root = fileURLToPath(new URL('../', import.meta.url));
const archiveName = `actionlint_${version}_linux_amd64.tar.gz`;
const archive = process.env.HEDGEHOG_ACTIONLINT_ARCHIVE
    || join(root, 'node_modules', '.cache', 'hedgehog-runner', archiveName);

async function checkedArchive() {
    if (process.platform !== 'linux' || process.arch !== 'x64') {
        throw new Error('Workflow linting currently requires the project-supported Linux x86-64 development host.');
    }
    if (!existsSync(archive)) {
        if (process.env.HEDGEHOG_ACTIONLINT_ARCHIVE) throw new Error(`Configured actionlint archive does not exist: ${archive}`);
        console.log(`Downloading actionlint ${version} to the project development cache (no sudo).`);
        const response = await fetch(`https://github.com/rhysd/actionlint/releases/download/v${version}/${archiveName}`, {
            signal: AbortSignal.timeout(30_000),
        });
        if (!response.ok) throw new Error(`Could not download actionlint (${response.status}).`);
        const bytes = Buffer.from(await response.arrayBuffer());
        if (createHash('sha256').update(bytes).digest('hex') !== digest) throw new Error('Downloaded actionlint archive digest mismatch.');
        mkdirSync(dirname(archive), { recursive: true });
        writeFileSync(archive, bytes);
    }
    if (createHash('sha256').update(readFileSync(archive)).digest('hex') !== digest) {
        throw new Error(`actionlint archive digest mismatch: ${archive}`);
    }
}

function run(command, args, input) {
    const result = spawnSync(command, args, { cwd: root, stdio: input === undefined ? 'inherit' : ['pipe', 'inherit', 'inherit'], input });
    if (result.error || result.status !== 0) throw new Error(`${command} failed (${result.status ?? result.error?.message}).`);
}

let temporary;
try {
    await checkedArchive();
    temporary = mkdtempSync(join(tmpdir(), 'hedgehog-actionlint-'));
    run('tar', ['-xzf', archive, '-C', temporary, 'actionlint']);
    const binary = join(temporary, 'actionlint');
    // Keep lint results independent of optional system shellcheck/pyflakes installs.
    const flags = ['-shellcheck=', '-pyflakes='];
    const workflows = join(root, '.github', 'workflows');
    const files = readdirSync(workflows).filter((name) => /\.ya?ml$/.test(name)).sort().map((name) => join(workflows, name));
    run(binary, [...flags, ...files]);

    for (const job of ['e2e', 'browser_tests']) {
        const document = parseDocument(workflowExample({ repository: 'example/project', labels: ['laptop'] }, { job }));
        if (document.errors.length) throw new Error(document.errors[0].message);
        const jobs = document.toJS();
        // Validate against the actual local reusable-workflow interface before publication.
        jobs.runner_selection.uses = './.github/workflows/select-runner.yml';
        jobs[job].steps = [{ run: 'echo "Replace this example step with the existing workload steps."' }];
        const content = stringify({ name: 'Generated integration example', on: ['pull_request', 'push'], jobs });
        run(binary, [...flags, '-stdin-filename', join(workflows, `generated-${job}.yml`), '-'], content);
    }
    console.log(`actionlint ${version}: repository workflows and generated integration examples passed.`);
} catch (error) {
    console.error(error.message);
    process.exitCode = 1;
} finally {
    if (temporary) rmSync(temporary, { recursive: true, force: true });
}
