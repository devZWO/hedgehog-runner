import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { validateConfig } from '../src/config.mjs';
import { runCli } from '../src/runner.mjs';

test('remove resolves an explicit repository outside a checkout without labels or a runner name', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'hedgehog-cli-'));
    const configOptions = {
        cwd: directory, configHome: join(directory, 'config'),
        user: { uid: 1000, username: 'owner', homedir: directory },
    };
    const calls = [];
    const runnerFactory = (config) => ({ main: async (args) => { calls.push({ config, args }); return 0; } });
    try {
        // Explicit targeting must also ignore an unrelated or broken project file.
        writeFileSync(join(directory, '.hedgehog.json'), '{');
        assert.equal(await runCli(['remove', '--repository', 'Example/Project'], { configOptions, runnerFactory }), 0);
        const defaultAccount = validateConfig({ version: 1, repository: 'example/project', labels: ['laptop'] }).account;
        assert.deepEqual(calls[0], {
            args: ['remove'], config: { repository: 'Example/Project', labels: [], account: defaultAccount,
                runnerName: undefined, configureOwner: false, jobEnv: {} },
        });
        const profileDirectory = join(configOptions.configHome, 'hedgehog-runner', 'example');
        mkdirSync(profileDirectory, { recursive: true });
        writeFileSync(join(profileDirectory, 'project.json'), JSON.stringify({ account: 'gha-local' }));
        assert.equal(await runCli(['--repository=example/project', 'remove'], { configOptions, runnerFactory }), 0);
        assert.equal(calls[1].config.account, 'gha-local');
        assert.equal(await runCli(['remove', '--repository', 'example/project', '--account', 'gha-other'], { configOptions, runnerFactory }), 0);
        assert.equal(calls[2].config.account, 'gha-other');
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('invalid or ambiguous removal targets fail before invoking any host operation', async () => {
    const errors = [];
    const originalError = console.error;
    console.error = (message) => errors.push(message);
    const options = {
        configOptions: { user: { uid: 1000, username: 'owner', homedir: '/unused' }, configHome: '/unused' },
        runnerFactory: () => assert.fail('Invalid targets must not reach the host'),
    };
    try {
        const cases = [
            [['remove', '--account', 'gha-existing'], /Missing repository/],
            [['remove', '--repository', 'example/..'], /owner\/repository/],
            [['remove', '--repository', 'example/project', '--account', 'root'], /dedicated Linux username/],
            [['remove', '--repository', 'example/project', '--config', '/missing/hedgehog.json'], /Could not read/],
            [['remove', '--repository', 'example/project', '--repository', 'other/project'], /only once/],
            [['remove', '--repository'], /argument missing/i],
            [['remove', '--repository', ''], /requires a value/],
            [['remove', '--account', '--repository', 'example/project'], /ambiguous|requires a value/i],
            [['setup', '--repository', 'example/project'], /Missing labels/],
            [['setup', '--configure-owner', '--no-configure-owner'], /Choose either/],
            [['start', '--repository', 'example/project', '--job-env', 'HOME=bad'], /Unsupported jobEnv/],
            [['start', '--repository', 'example/project', '--job-env', 'INVALID'], /NAME=VALUE/],
            [['start', '--repository', 'example/project', '--job-env', 'A=1', '--job-env', 'A=2'], /Duplicate/],
            [['remove', '--unknown'], /Unknown option/],
        ];
        for (const [args, message] of cases) {
            assert.equal(await runCli(args, options), 1);
            assert.match(errors.at(-1), message);
        }
    } finally {
        console.error = originalError;
    }
});

test('CLI overrides project and profile values consistently across lifecycle commands', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'hedgehog-overrides-'));
    const file = join(directory, 'custom.json');
    const configOptions = { cwd: directory, configHome: directory, user: { uid: 1000, username: 'owner', homedir: directory }, log() {} };
    mkdirSync(join(directory, 'hedgehog-runner/example'), { recursive: true });
    writeFileSync(join(directory, 'hedgehog-runner/example/new.json'), JSON.stringify({ account: 'gha-profile', runnerName: 'profile-name' }));
    writeFileSync(file, JSON.stringify({ version: 1, repository: 'example/old', labels: ['old'], configureOwner: true, jobEnv: { OLD: 'gone' } }));
    try {
        for (const command of ['check', 'setup', 'instructions', 'configure-owner', 'rename', 'status', 'start', 'stop', 'remove']) {
            let resolved;
            assert.equal(await runCli(['--config', file, command, '--repository', 'example/new',
                '--label', 'laptop', '--label', 'e2e', '--no-configure-owner',
                '--job-env', 'CUSTOM=value=with=equals', '--job-env', 'EMPTY=', '--account', 'gha-cli', '--runner-name', 'cli-name'], {
                configOptions, interactive: false, prompt: () => assert.fail('Complete options need no prompts'),
                runnerFactory: (config) => ({ main: async (args) => { resolved = config; assert.deepEqual(args, [command]); return 0; } }),
            }), 0);
            assert.deepEqual(resolved, { repository: 'example/new', labels: ['laptop', 'e2e'], configureOwner: false,
                jobEnv: { CUSTOM: 'value=with=equals', EMPTY: '' }, account: 'gha-cli', runnerName: 'cli-name' });
        }
    } finally { rmSync(directory, { recursive: true, force: true }); }
});
