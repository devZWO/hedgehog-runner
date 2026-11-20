import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const packageFiles = [
    'CHANGELOG.md', 'LICENSE', 'README.md', 'ai/usage.md',
    'docs/package-info.json', 'docs/select-runner.yml', 'llms.txt', 'package.json',
    'src/cli.mjs', 'src/config.mjs', 'src/package-info.mjs', 'src/runner.mjs', 'src/workflow.mjs',
].sort();

export function auditPackageFiles(files) {
    assert.deepEqual([...files].sort(), packageFiles, 'npm archive must contain exactly the reviewed runtime and integration documents');
}

export function checkLocalLinks(root) {
    for (const name of packageFiles.filter((path) => /\.md$|^llms\.txt$/.test(path))) {
        const content = readFileSync(join(root, name), 'utf8');
        for (const match of content.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
            const target = match[1];
            if (/^[a-z][a-z\d+.-]*:/i.test(target)) continue;
            const [path, fragment] = target.split('#');
            const resolved = path ? resolve(root, dirname(name), decodeURIComponent(path)) : join(root, name);
            assert.ok(!relative(root, resolved).startsWith('..'), `${name}: link escapes the installed package: ${target}`);
            assert.ok(existsSync(resolved), `${name}: broken local link: ${target}`);
            if (fragment) {
                const headings = [...readFileSync(resolved, 'utf8').matchAll(/^#{1,6}\s+(.+)$/gm)]
                    .map((heading) => heading[1].toLowerCase().replace(/[^\p{L}\p{N}_ -]/gu, '').replace(/ /g, '-'));
                assert.ok(headings.includes(decodeURIComponent(fragment)), `${name}: missing local heading: ${target}`);
            }
        }
    }
}

function run(command, args, { cwd, input } = {}) {
    const result = spawnSync(command, args, { cwd, input, encoding: 'utf8' });
    if (result.error || result.status !== 0) throw new Error(`${command} failed: ${result.stderr || result.error?.message || result.stdout}`);
    return result.stdout;
}

export function checkPackage({ root = fileURLToPath(new URL('../', import.meta.url)), output = process.env.HEDGEHOG_PACKAGE_OUTPUT } = {}) {
    const temporary = mkdtempSync(join(tmpdir(), 'hedgehog-package-'));
    try {
        const cache = join(temporary, 'npm-cache');
        const packed = JSON.parse(run('npm', ['pack', '--json', '--silent', '--cache', cache, '--pack-destination', temporary], { cwd: root }))[0];
        auditPackageFiles(packed.files.map(({ path }) => path));
        const tarball = join(temporary, packed.filename);
        const archiveFiles = run('tar', ['-tzf', tarball]).trim().split('\n').map((path) => path.replace(/^package\//, ''));
        auditPackageFiles(archiveFiles);
        const install = join(temporary, 'install');
        run('npm', ['install', '--cache', cache, '--prefix', install, '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund', tarball]);
        const installed = join(install, 'node_modules', '@devzwo', 'hedgehog-runner');
        const manifest = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'));
        assert.deepEqual(manifest.dependencies ?? {}, {}, 'CLI must remain free of production dependencies');
        assert.ok(!existsSync(join(install, 'node_modules', 'yaml')), 'Development tooling must not be installed for consumers');
        checkLocalLinks(installed);
        const metadata = JSON.parse(readFileSync(join(installed, 'docs/package-info.json'), 'utf8'));
        assert.equal(metadata.version, manifest.version);
        assert.equal(metadata.name, manifest.name);
        const snapshot = readFileSync(join(installed, 'docs/select-runner.yml'));
        assert.equal(metadata.workflow.sha256, createHash('sha256').update(snapshot).digest('hex'));
        assert.equal(snapshot.toString(), readFileSync(join(root, '.github/workflows/select-runner.yml'), 'utf8'));
        const binary = join(install, 'node_modules', '.bin', 'hedgehog-runner');
        const version = run(binary, ['--version'], { cwd: temporary }).trim();
        assert.equal(version, manifest.version);
        assert.equal(run(binary, ['version'], { cwd: temporary }).trim(), manifest.version);
        const help = run(binary, ['--help'], { cwd: temporary });
        assert.match(help, /workflow.*Print a CI runner-selection/);
        assert.match(help, /ai\/usage\.md/);
        const example = run(binary, ['workflow', '--repository', 'example-org/example-repo', '--label', 'laptop', '--job', 'e2e'], { cwd: temporary });
        assert.match(example, /runner_selection:/);
        if (metadata.workflow.commit) {
            assert.match(example, new RegExp(`@${metadata.workflow.commit}\\b`));
            assert.doesNotMatch(example, /TEMPLATE ONLY|REPLACE_WITH_PUBLISHED/);
        } else assert.match(example, /TEMPLATE ONLY/);
        if (process.env.GITHUB_EVENT_NAME === 'release') {
            assert.equal(metadata.release, true, 'Release package must come from a clean official tagged checkout');
            assert.equal(metadata.workflow.commit, process.env.GITHUB_SHA);
        }
        if (output) {
            mkdirSync(output, { recursive: true });
            copyFileSync(tarball, join(output, packed.filename));
            const digest = createHash('sha256').update(readFileSync(tarball)).digest('hex');
            writeFileSync(join(output, 'SHA256SUMS'), `${digest}  ${packed.filename}\n`);
        }
        console.log(`Package check passed: ${packed.files.length} reviewed files, ${packed.size} bytes packed, version ${version}.`);
        console.log(packed.files.map(({ path }) => `  ${path}`).join('\n'));
    } finally { rmSync(temporary, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try { checkPackage(); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
}
