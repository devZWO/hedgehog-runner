import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadConfig, validateConfig } from '../src/config.mjs';
import { createRunner } from '../src/runner.mjs';

const project = { version: 1, repository: 'Example/Project', labels: ['laptop', 'e2e'] };

test('only the local profile can select the Linux account and runner name', () => {
    const defaults = validateConfig(project);
    assert.match(defaults.account, /^gha-[a-f0-9]{12}$/);
    assert.equal(defaults.account, validateConfig({ ...project, repository: 'example/project' }).account);
    assert.notEqual(defaults.account, validateConfig({ ...project, repository: 'example/other' }).account);
    assert.equal(defaults.configureOwner, false);
    assert.throws(() => validateConfig({ ...project, account: 'gha-other' }), /Unknown field "account"/);
    assert.throws(() => validateConfig(project, { account: 'root' }), /dedicated Linux username/);
    const local = validateConfig(project, { account: 'gha-existing', runnerName: 'workstation-a' });
    assert.equal(local.account, 'gha-existing');
    assert.equal(local.runnerName, 'workstation-a');
    assert.match(createRunner(local).registrationGuide(), /workstation-a/);
    assert.equal(createRunner(local).registrationCommand(local.runnerName).at(-1), 'laptop,e2e');
});

test('rejects malformed configuration before building shell commands or profile paths', () => {
    assert.throws(() => validateConfig({ ...project, repository: 'example/..' }), /owner\/repository/);
    assert.throws(() => validateConfig({ ...project, labels: ['laptop', 'Laptop'] }), /unique/);
    assert.throws(() => validateConfig({ ...project, configureOwner: 'true' }), /boolean/);
    assert.throws(() => validateConfig({ ...project, jobEnv: { XDG_RUNTIME_DIR: '/tmp' } }), /Unsupported jobEnv/);
    assert.throws(() => validateConfig({ ...project, jobEnv: { CUSTOM: 'line\nnext' } }), /single-line/);
    assert.throws(() => validateConfig({ ...project, jobEnv: { CUSTOM: 42 } }), /single-line/);
});

test('finds configuration from a Git subdirectory and applies the local profile', () => {
    const directory = mkdtempSync(join(tmpdir(), 'hedgehog-config-'));
    try {
        const subdirectory = join(directory, 'src');
        const configHome = join(directory, 'config');
        const profileDirectory = join(configHome, 'hedgehog-runner', 'example');
        mkdirSync(subdirectory);
        mkdirSync(profileDirectory, { recursive: true });
        assert.equal(spawnSync('git', ['init', '-q', directory]).status, 0);
        writeFileSync(join(directory, '.runnerconfig'), JSON.stringify(project));
        writeFileSync(join(profileDirectory, 'project.json'), '{"account":"gha-existing"}');
        const options = { cwd: subdirectory, user: { uid: 1000, username: 'owner', homedir: directory }, configHome };
        assert.equal(loadConfig(undefined, options).account, 'gha-existing');
        assert.equal(loadConfig('../.runnerconfig', options).repository, project.repository);
        writeFileSync(join(profileDirectory, 'project.json'), '{');
        assert.throws(() => loadConfig(undefined, options), /Invalid JSON.*project.json/);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('replaces only managed runner environment entries across restarts', () => {
    const existing = 'CUSTOM_CACHE=/existing\n';
    const value = 'literal = value with spaces';
    const configured = createRunner(validateConfig({ ...project, jobEnv: { CUSTOM_CACHE: value, OLD_KEY: 'gone' } }));
    const first = configured.runnerEnvFile(existing);
    assert.match(first, /^CUSTOM_CACHE=\/existing\n# BEGIN HEDGEHOG RUNNER\nCUSTOM_CACHE=literal = value with spaces/m);
    assert.equal(configured.runnerEnvFile(first), first);
    const next = createRunner(validateConfig({ ...project, jobEnv: { CUSTOM_CACHE: 'new' } })).runnerEnvFile(first);
    assert.doesNotMatch(next, /OLD_KEY/);
    assert.match(next, /CUSTOM_CACHE=new/);
    assert.equal(createRunner(validateConfig(project)).runnerEnvFile(next), existing);
    assert.throws(() => configured.runnerEnvFile('# BEGIN HEDGEHOG RUNNER\n'), /Malformed/);
});
