import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ensureSudo, listInstalledRunners, runCli } from '../src/runner.mjs';

function inventory(entries) {
    const calls = [];
    return {
        calls,
        run(argv) {
            calls.push(argv);
            if (argv.join(' ') === 'sudo -n -v') return { status: 0 };
            if (argv.join(' ') === 'getent passwd') return { status: 0, stdout: entries.map(({ account, home, uid = 1001 }) =>
                `${account}:x:${uid}:1001::${home ?? `/home/${account}`}:/bin/bash`).join('\n') };
            assert.deepEqual(argv.slice(0, 3), ['sudo', '-n', '-u']);
            const entry = entries.find(({ account }) => account === argv[3]);
            assert.ok(entry, 'Only enumerated dedicated accounts may be inspected');
            assert.ok(argv.includes('env') && argv.includes('-i'));
            assert.equal(argv.at(-1), `/home/${entry.account}/actions-runner`);
            return { status: entry.status ?? 0, stdout: entry.metadata ?? JSON.stringify({
                agentName: entry.name ?? 'same-name', gitHubUrl: `https://github.com/${entry.repository}`,
            }) };
        },
    };
}

test('list groups multiple local runners by registered repository, not display name', () => {
    const io = inventory([
        { account: 'owner' },
        { account: 'gha-b', repository: 'Org/B' },
        { account: 'gha-a2', repository: 'org/a', name: 'second' },
        { account: 'gha-a1', repository: 'ORG/A' },
        { account: 'gha-absent', status: 3 },
        { account: 'gha-new', status: 2, metadata: '' },
    ]);
    const result = listInstalledRunners(io);
    assert.equal(result.code, 0);
    assert.match(result.output, /^org\/a:\n  same-name — gha-a1.*\n  second — gha-a2.*\norg\/b:\n  same-name — gha-b/m);
    assert.match(result.output, /Unregistered installations:\n  gha-new/);
    assert.doesNotMatch(result.output, /gha-absent|owner/);
    assert.equal(io.calls.length, 6);
});

test('list reports inaccessible accounts and invalid registrations as incomplete without prompting', () => {
    const io = inventory([
        { account: 'gha-valid', repository: 'org/repo' },
        { account: 'gha-denied', status: 1, metadata: '' },
        { account: 'gha-broken', metadata: '{' },
        { account: 'gha-empty', metadata: '' },
        { account: 'gha-invalid', repository: '../..' },
        { account: 'gha-home', home: '/unexpected' },
        { account: 'gha-root', uid: 0 },
    ]);
    const result = listInstalledRunners(io);
    assert.equal(result.code, 1);
    assert.match(result.output, /org\/repo:/);
    assert.match(result.output, /inventory incomplete/);
    for (const account of ['denied', 'broken', 'empty', 'invalid', 'home', 'root']) assert.match(result.output, new RegExp(`gha-${account}:`));
    assert.match(result.output, /account probe exited with status 1/);
    assert.doesNotMatch(result.output, /authentication is required/);
    assert.equal(io.calls.length, 7, 'Unsafe account metadata must not be used in commands');
});

test('list reports empty inventory and account enumeration failures accurately', () => {
    assert.deepEqual(listInstalledRunners(inventory([])), { code: 0, output: 'No installed Hedgehog runners found.' });
    assert.throws(() => listInstalledRunners({ run: () => ({ status: 1 }) }), /Could not enumerate/);
});

test('list bypasses configuration and never invokes configuration or lifecycle prompts', async () => {
    const output = [];
    const originalLog = console.log;
    console.log = (value) => output.push(value);
    try {
        assert.equal(await runCli(['list'], {
            configOptions: { cwd: '/does-not-exist' }, listIo: inventory([]), interactive: true,
            runnerFactory: () => assert.fail('list must not resolve a configured runner'),
            prompt: () => assert.fail('list must not prompt'), confirm: () => assert.fail('list must not confirm'),
        }), 0);
    } finally { console.log = originalLog; }
    assert.match(output[0], /No installed/);
});

test('sudo reuses cached credentials and only prompts in an interactive terminal', () => {
    let executions = 0;
    const cached = { run: () => ({ status: 0 }), exec: () => assert.fail('Cached authentication needs no prompt') };
    assert.equal(ensureSudo(cached, { interactive: true }), false);
    const missing = { run: () => ({ status: 1 }), exec: (argv) => { assert.deepEqual(argv, ['sudo', '-v']); executions++; } };
    assert.throws(() => ensureSudo(missing, { interactive: false }), /no interactive terminal.*WebStorm Terminal/s);
    assert.equal(executions, 0);
    assert.equal(ensureSudo(missing, { interactive: true, log() {} }), true);
    assert.equal(executions, 1);
    assert.throws(() => ensureSudo({ ...missing, exec() { throw new Error('cancelled'); } }, { interactive: true, log() {} }), /failed or was cancelled/);
});

function expiredInventory({ cancelled = false } = {}) {
    const base = inventory([{ account: 'gha-first', repository: 'org/repo' }, { account: 'gha-second', repository: 'org/repo' }]);
    let authenticated = false;
    let attempts = 0;
    return {
        get attempts() { return attempts; },
        run(argv) {
            if (argv[0] === 'sudo' && !authenticated) return { status: 1, stdout: '', stderr: 'sudo: a password is required' };
            return base.run(argv);
        },
        exec(argv) {
            assert.deepEqual(argv, ['sudo', '-v']);
            attempts++;
            if (cancelled) throw new Error('cancelled');
            authenticated = true;
        },
    };
}

test('list authenticates once and retries the failed read before inspecting remaining accounts', () => {
    const io = expiredInventory();
    const result = listInstalledRunners(io, { interactive: true, log() {} });
    assert.equal(io.attempts, 1);
    assert.equal(result.code, 0);
    assert.match(result.output, /org\/repo:.*gha-first.*gha-second/s);
});

test('list preserves partial results with specific authentication errors without a terminal or after cancellation', () => {
    for (const interactive of [false, true]) {
        const io = expiredInventory({ cancelled: true });
        const result = listInstalledRunners(io, { interactive, log() {} });
        assert.equal(result.code, 1);
        assert.equal(io.attempts, interactive ? 1 : 0);
        assert.match(result.output, /gha-first:.*gha-second:/s);
        assert.match(result.output, interactive ? /failed or was cancelled/ : /no interactive terminal/);
        assert.match(result.output, /sudo: a password is required/);
    }
});
