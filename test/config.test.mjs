import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadConfig, validateConfig } from '../src/config.mjs';
import { createRunner } from '../src/runner.mjs';

const project = { version: 1, repository: 'Example/Project', labels: ['laptop', 'e2e'] };

test('project settings exclude the local Linux account and runner name', () => {
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

test('interactive setup validates missing inputs and saves reviewed project and local settings', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'hedgehog-interactive-'));
    const projectPath = join(directory, '.hedgehog.json');
    const profilePath = join(directory, 'config/hedgehog-runner/example/project.json');
    const messages = [];
    const answers = ['invalid', 'example/project', 'laptop, e2e'];
    const options = { command: 'setup', cwd: directory, configHome: join(directory, 'config'),
        user: { uid: 1000, username: 'owner', homedir: directory }, interactive: true,
        prompt: async () => answers.shift(), log: (message) => messages.push(message),
        confirm: async () => {
            assert.equal(existsSync(projectPath), false);
            assert.equal(existsSync(profilePath), false);
            assert.ok(messages.some((message) => message.includes(projectPath)));
            assert.ok(messages.some((message) => message.includes(profilePath)));
            return true;
        },
    };
    try {
        const config = await loadConfig(undefined, { account: 'gha-existing', runnerName: 'shared-name' }, options);
        assert.equal(config.repository, 'example/project');
        assert.deepEqual(config.labels, ['laptop', 'e2e']);
        assert.equal(answers.length, 0);
        assert.match(messages[0], /owner\/repository/);
        const saved = JSON.parse(readFileSync(projectPath, 'utf8'));
        assert.equal(saved.version, 1);
        assert.equal(saved.account, undefined);
        assert.deepEqual(JSON.parse(readFileSync(profilePath, 'utf8')), { account: 'gha-existing', runnerName: 'shared-name' });
        assert.deepEqual(await loadConfig(undefined, {}, { ...options, command: 'start',
            prompt: () => assert.fail('Saved values must avoid prompts'), confirm: () => assert.fail('Must not save again'),
        }), config);
    } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('declining persistence leaves files untouched and noninteractive commands never ask for input', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'hedgehog-unsaved-'));
    const options = { cwd: directory, configHome: directory, user: { uid: 1000, username: 'owner', homedir: directory }, log() {} };
    try {
        const answers = ['example/project', 'laptop'];
        await loadConfig(undefined, {}, { ...options, command: 'setup', interactive: true,
            prompt: async () => answers.shift(), confirm: async () => false });
        assert.equal(existsSync(join(directory, '.hedgehog.json')), false);
        for (const command of ['setup', 'check', 'status', 'start', 'remove']) {
            await assert.rejects(loadConfig(undefined, {}, { ...options, command,
                interactive: command !== 'setup', prompt: () => assert.fail('Must not prompt'),
            }), /Missing repository/);
        }
    } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('invalid configuration is reported even when CLI overrides could hide it', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'hedgehog-invalid-'));
    const path = join(directory, '.hedgehog.json');
    const options = { cwd: directory, command: 'setup', interactive: true,
        user: { uid: 1000, username: 'owner', homedir: directory }, prompt: () => assert.fail('Invalid values must fail before prompts') };
    try {
        writeFileSync(path, JSON.stringify({ ...project, labels: [] }));
        await assert.rejects(loadConfig(path, { labels: ['valid'] }, options), /at least one/);
        writeFileSync(path, '{');
        await assert.rejects(loadConfig(path, {}, options), /Invalid JSON/);
        writeFileSync(path, 'null');
        await assert.rejects(loadConfig(path, { repository: 'example/project' }, options), /JSON object/);
        await assert.rejects(loadConfig('/missing/hedgehog.json', {}, options), /Could not read/);
    } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('rejects malformed configuration before building shell commands or profile paths', () => {
    assert.throws(() => validateConfig({ ...project, repository: 'example/..' }), /owner\/repository/);
    assert.throws(() => validateConfig({ ...project, labels: ['laptop', 'Laptop'] }), /unique/);
    assert.throws(() => validateConfig({ ...project, configureOwner: 'true' }), /boolean/);
    assert.throws(() => validateConfig({ ...project, jobEnv: { XDG_RUNTIME_DIR: '/tmp' } }), /Unsupported jobEnv/);
    assert.throws(() => validateConfig({ ...project, jobEnv: { CUSTOM: 'line\nnext' } }), /single-line/);
    assert.throws(() => validateConfig({ ...project, jobEnv: { CUSTOM: 42 } }), /single-line/);
});

test('finds configuration from a Git subdirectory and applies the local profile', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'hedgehog-config-'));
    try {
        const subdirectory = join(directory, 'src');
        const configHome = join(directory, 'config');
        const profileDirectory = join(configHome, 'hedgehog-runner', 'example');
        mkdirSync(subdirectory);
        mkdirSync(profileDirectory, { recursive: true });
        assert.equal(spawnSync('git', ['init', '-q', directory]).status, 0);
        writeFileSync(join(directory, '.hedgehog.json'), JSON.stringify(project));
        writeFileSync(join(profileDirectory, 'project.json'), '{"account":"gha-existing"}');
        const options = { cwd: subdirectory, user: { uid: 1000, username: 'owner', homedir: directory }, configHome };
        assert.equal((await loadConfig(undefined, {}, options)).account, 'gha-existing');
        assert.equal((await loadConfig('../.hedgehog.json', {}, options)).repository, project.repository);
        writeFileSync(join(profileDirectory, 'project.json'), '{');
        await assert.rejects(loadConfig(undefined, {}, options), /Invalid JSON.*project.json/);
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
