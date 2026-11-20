/**
 * Regression coverage for the laptop runner lifecycle. System commands are
 * simulated through an injected runner; wrapper tests execute without sudo.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRunner } from '../src/runner.mjs';

const config = { account: 'gha-example', repository: 'example-org/example-repo',
    labels: ['example-laptop'], configureOwner: true, jobEnv: {} };
const {
    account, accountDirectories, accountHome, asAccount, assertDigest, assertSupportedPlatform, assertSystemdUserManager,
    blockingProblems, getAccountUid, inspectHost, main, parseOsRelease, planChanges, registrationCommand,
    parseGitHubUser, registrationGuide, removalCommand, removalFollowUps, runnerDirectory, runnerDirectoryRemovalCommand, runnerLabel,
    runtimeDirectoryFor, startScriptArguments, startScriptFor, systemdUserEnvironment, terminateAccountProcesses,
    versionMarker, versionMarkerPath, ownerVariableCommand, ownerVariableName, runnerName,
} = createRunner(config);

const ubuntu = 'NAME="Ubuntu"\nID=ubuntu\nVERSION_ID="26.04"\nPRETTY_NAME="Ubuntu 26.04.1 LTS"\n';

function accountInnerCommand(argv) {
    const wrapperIndex = argv.findIndex((part, index) => part === 'sh' && argv[index + 1] === '-c'
        && argv[index + 2] === 'cd "$HOME" && exec "$@"');
    const wrapper = argv.slice(wrapperIndex);
    assert.deepEqual(wrapper.slice(0, 4), ['sh', '-c', 'cd "$HOME" && exec "$@"', 'sh']);
    return wrapper.slice(4);
}

function fakeSystemdHost({ uid = '1001', linger = true, runtime = true, bus = true, manager = true } = {}) {
    const calls = [];
    return {
        calls,
        run(argv) {
            calls.push(argv);
            if (argv[0] === 'id' && argv[1] === '-u') return { status: 0, stdout: `${uid}\n`, stderr: '' };
            if (argv[0] === 'sudo' && argv.includes('loginctl')) {
                return { status: 0, stdout: `${linger ? 'yes' : 'no'}\n`, stderr: '' };
            }
            if (argv[0] === 'sudo' && argv.includes('env')) {
                const inner = accountInnerCommand(argv);
                if (inner[0] === 'stat') return { status: runtime ? 0 : 1, stdout: runtime ? `${uid}:700\n` : '', stderr: '' };
                if (inner[0] === 'test') return { status: bus ? 0 : 1, stdout: '', stderr: '' };
                if (inner[0] === 'systemctl') return { status: manager ? 0 : 1, stdout: '', stderr: manager ? '' : 'Failed to connect to bus' };
            }
            throw new Error(`Unexpected command in test: ${argv.join(' ')}`);
        },
    };
}

function fakeGitHubIo({
    currentUser = { login: 'installer', id: 12345 },
    users = {},
    ghInstalled = true,
    authenticated = true,
    variable = '12345',
    failLookup = false,
    failPublicLookup = false,
    failVariableRead = false,
    failWrite = false,
} = {}) {
    const calls = [];
    return {
        calls,
        run(argv) {
            calls.push(argv);
            if (argv[0] !== 'gh') throw new Error(`Unexpected command: ${argv.join(' ')}`);
            if (argv[1] === '--version') return { status: ghInstalled ? 0 : 127, stdout: '', stderr: '' };
            if (argv[1] === 'auth' && argv[2] === 'status') return { status: authenticated ? 0 : 1, stdout: '', stderr: '' };
            if (argv[1] === 'api' && argv[2] === '--paginate') {
                return { status: failVariableRead ? 1 : 0, stdout: variable ?? '', stderr: '' };
            }
            if (argv[1] !== 'api') throw new Error(`Unexpected command: ${argv.join(' ')}`);
            if (argv[2] === 'user') return { status: 0, stdout: JSON.stringify(currentUser), stderr: '' };
            if (argv[2]?.startsWith('users/')) {
                const username = decodeURIComponent(argv[2].slice('users/'.length));
                const user = users[username];
                return { status: user && !failLookup ? 0 : 1, stdout: user ? JSON.stringify(user) : '', stderr: '' };
            }
            throw new Error(`Unexpected GitHub API command: ${argv.join(' ')}`);
        },
        async fetch(url) {
            calls.push(['fetch', url]);
            const parsedUrl = new URL(url);
            const [, resource, identifier] = parsedUrl.pathname.split('/');
            const user = resource === 'users'
                ? users[decodeURIComponent(identifier)]
                : resource === 'user'
                    ? Object.values(users).find(({ id }) => String(id) === identifier) ?? currentUser
                    : undefined;
            const shouldFail = !user || (resource === 'users' && (failPublicLookup || failLookup)) || (resource === 'user' && failLookup);
            return {
                ok: !shouldFail,
                status: shouldFail ? 404 : 200,
                async text() { return user ? JSON.stringify(user) : ''; },
            };
        },
        exec(argv) {
            calls.push(argv);
            if (failWrite) throw new Error('simulated permission denied');
        },
    };
}

/** Simulated host; `prepared` describes a fully set-up account. */
function fakeHost({ prepared = true, registered = false, registeredName = 'old-runner', registrationUrl = 'https://github.com/example-org/example-repo', registrationWorks = true, removalWorks = true, listenerRunning = false, os = ubuntu, arch = 'x64', groups = `${account}`, homeMode = '750', acl = 'user::rwx\ngroup::r-x\nother::---\n', sudoCached = true, linger = true, lingerReadable = true, enableWorks = true, accountDirectoryProbeFailureAt = Number.POSITIVE_INFINITY, missingCommands = [] } = {}) {
    const calls = [];
    let lingering = linger;
    let accountExists = prepared;
    let runnerRegistered = registered;
    let runnerRegistrationName = registeredName;
    let accountDirectoryProbeCount = 0;
    const files = {
        '/etc/os-release': os,
    };
    const accountFiles = prepared ? { [versionMarkerPath]: versionMarker } : {};
    const result = (status, stdout = '') => ({ status, stdout, stderr: '' });
    return {
        calls,
        arch,
        platform: 'linux',
        home: '/home/owner',
        readText: (path) => files[path],
        run(argv) {
            calls.push(argv);
            const command = argv.join(' ');
            if (argv[0] === 'sh' && argv[1] === '-c' && argv[2].startsWith('command -v ')) {
                return result(missingCommands.includes(argv[2].slice(11)) ? 1 : 0);
            }
            if (command === 'id -gn') return result(0, 'owner\n');
            if (command === `stat -c %a /home/owner`) return result(0, `${homeMode}\n`);
            if (argv[0] === 'getfacl') return result(0, acl);
            if (command === `getent passwd ${account}`) return accountExists ? result(0, `${account}:x:1001:1001::${accountHome}:/bin/bash\n`) : result(2);
            if (command === 'sudo -n true') return result(sudoCached ? 0 : 1);
            if (command === `id -Gn ${account}`) return result(0, `${groups}\n`);
            if (command === `stat -c %a ${accountHome}`) return result(0, '700\n');
            if (command === `sudo -n -l -U ${account}`) return result(0, `User ${account} is not allowed to run sudo on laptop.\n`);
            if (argv[0] === 'sudo' && argv[1] === '-n' && argv[2] === 'sh' && argv[3] === '-c' && argv[7] === '/var/lib/systemd') {
                assert.equal(argv[6], account);
                return result(lingerReadable ? 0 : 1, lingerReadable ? `${lingering ? 'yes' : 'no'}\n` : '');
            }
            if (argv[0] === 'pgrep') {
                const processPattern = argv.at(-1);
                return result(processPattern === 'Runner.Listener' && listenerRunning ? 0 : 1);
            }
            if (argv[0] === 'sudo' && argv.includes('env')) {
                const inner = accountInnerCommand(argv);
                if (inner[0] === 'sh' && inner[2].startsWith('set -e; test -x "$HOME"; for p do')) {
                    accountDirectoryProbeCount++;
                    if (accountDirectoryProbeCount === accountDirectoryProbeFailureAt) {
                        return { status: 1, stdout: '', stderr: 'Permission denied while inspecting account directories' };
                    }
                    return result(0, prepared ? inner.slice(4).map((path) => `700 ${path}`).join('\n') + '\n' : '');
                }
                if (inner[0] === 'sh' && inner[2].startsWith('du -sh ')) return result(0);
                if (inner[0] === 'cat' && inner[1] === `${runnerDirectory}/.runner`) {
                    return runnerRegistered ? result(0, JSON.stringify({ agentName: runnerRegistrationName, gitHubUrl: registrationUrl })) : result(1);
                }
                if (inner[0] === 'cat') return inner[1] in accountFiles ? result(0, accountFiles[inner[1]]) : result(1);
                if (inner[0] === 'test' && inner[1] === '-f' && inner[2] === `${runnerDirectory}/.runner`) {
                    return result(runnerRegistered ? 0 : 1);
                }
                if (inner[0] === 'test') return result(prepared ? 0 : 1);
            }
            throw new Error(`Unexpected command in test: ${command}`);
        },
        exec(argv) {
            calls.push(argv);
            if (argv.join(' ') === 'sudo -v') return;
            if (argv[0] === 'sudo' && argv[1] === 'useradd') {
                accountExists = true;
                return;
            }
            if (argv.join(' ') === `sudo loginctl enable-linger ${account}`) {
                lingering = enableWorks;
                return;
            }
            if (JSON.stringify(argv.slice(0, -2)) === JSON.stringify(registrationCommand('placeholder').slice(0, -2))
                && argv.at(-1) === runnerLabel) {
                if (!registrationWorks) throw new Error('simulated runner registration failure');
                runnerRegistered = true;
                runnerRegistrationName = argv.at(-2);
                return;
            }
            if (JSON.stringify(argv) === JSON.stringify(removalCommand())) {
                if (!removalWorks) throw new Error('simulated runner removal failure');
                runnerRegistered = false;
                return;
            }
            throw new Error(`Unexpected executed command in test: ${argv.join(' ')}`);
        },
    };
}

function combinedRunnerIo(host, github) {
    return {
        ...host,
        run(argv) { return argv[0] === 'gh' ? github.run(argv) : host.run(argv); },
        exec(argv, options) { return argv[0] === 'gh' ? github.exec(argv, options) : host.exec(argv, options); },
        fetch: github.fetch,
    };
}

test('rejects unsupported operating systems and architectures with a remedy', () => {
    assert.throws(() => inspectHost(fakeHost({ os: 'ID=fedora\nPRETTY_NAME="Fedora 44"\n' })), /Unsupported host \(Fedora 44 x64\).*another runner on other platforms/);
    assert.throws(() => inspectHost(fakeHost({ arch: 'arm64' })), /Ubuntu Linux x86_64 only/);
    assert.throws(() => assertSupportedPlatform({ os: parseOsRelease(ubuntu), arch: 'x64', platform: 'darwin' }), /Unsupported/);
    assert.doesNotThrow(() => assertSupportedPlatform({ os: parseOsRelease(ubuntu), arch: 'x64', platform: 'linux' }));
});

test('runner names identify both the host and the confirmed GitHub owner', () => {
    assert.equal(runnerName('Laptop A', 'SampleUser'), 'laptop-a-sampleuser');
    assert.equal(runnerName('A'.repeat(80), 'A'.repeat(39)).length <= 63, true);
    assert.notEqual(runnerName(`${'a'.repeat(80)}-one`, 'owner'), runnerName(`${'a'.repeat(80)}-two`, 'owner'));
    assert.throws(() => runnerName('laptop', 'not a login'), /valid GitHub login/);
});

test('a fully prepared host needs no changes, so prepare is idempotent', () => {
    const host = fakeHost();
    const state = inspectHost(host);
    assert.deepEqual(blockingProblems(state), []);
    assert.deepEqual(planChanges(state), []);
    assert.deepEqual(planChanges(inspectHost(host)), []);
});

test('an existing account plans Lingering only when its state is confirmed disabled', () => {
    const disabled = inspectHost(fakeHost({ linger: false }));
    assert.deepEqual(disabled.lingering, { known: true, enabled: false });
    const change = planChanges(disabled).find(({ id }) => id === 'enable-lingering');
    assert.deepEqual(change.steps[0].argv, ['sudo', 'loginctl', 'enable-linger', account]);
    assert.equal(change.admin, true);

    const unknown = inspectHost(fakeHost({ lingerReadable: false }));
    assert.deepEqual(unknown.lingering, { known: false, enabled: false });
    assert.equal(planChanges(unknown).some(({ id }) => id === 'enable-lingering'), false);
});

test('the Lingering marker probe distinguishes missing directories, enabled markers and broken state', () => {
    const host = fakeHost();
    inspectHost(host);
    const script = host.calls.find((argv) => argv[7] === '/var/lib/systemd')[4];
    const directory = mkdtempSync(join(process.cwd(), '.runner-linger-test-'));
    const probe = (parent = directory) => spawnSync('sh', ['-c', script, 'sh', account, parent], { encoding: 'utf8' });
    try {
        assert.equal(probe(join(directory, 'missing')).status, 1);
        assert.equal(probe().stdout, 'no\n');
        mkdirSync(join(directory, 'linger'));
        assert.equal(probe().stdout, 'no\n');
        writeFileSync(join(directory, 'linger', account), '');
        assert.equal(probe().stdout, 'yes\n');
        rmSync(join(directory, 'linger'), { recursive: true });
        symlinkSync('missing', join(directory, 'linger'));
        assert.equal(probe().status, 1);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('prepare enables Lingering, then configures the owner, skips existing registration and shows status', async () => {
    const host = fakeHost({ linger: false, registered: true });
    const github = fakeGitHubIo();
    const io = combinedRunnerIo(host, github);
    const output = [];
    const original = console.log;
    console.log = (message) => output.push(message);
    try {
        assert.equal(await main(['prepare'], io, {
            requireTerminal() {},
            async confirmChange() { return true; },
        }), 0);
    } finally {
        console.log = original;
    }
    assert.ok(host.calls.some((argv) => argv.join(' ') === `sudo loginctl enable-linger ${account}`));
    assert.match(output.join('\n'), /Host prepared/);
    assert.match(output.join('\n'), /Configured RUNNER_OWNER_ID.*@installer/);
    assert.match(output.join('\n'), /already registered as old-runner/);
    assert.match(output.join('\n'), /owner routing: @installer \(ID 12345\)/);
    assert.ok(output.findIndex((line) => /Configured RUNNER_OWNER_ID/.test(line))
        < output.findIndex((line) => /runner is already registered/.test(line)));
    assert.ok(output.findIndex((line) => /runner is already registered/.test(line))
        < output.findIndex((line) => /owner routing: @installer/.test(line)));
    assert.ok(github.calls.some((argv) => argv[0] === 'gh' && argv[1] === 'api' && argv[2] === '--paginate'));
    assert.deepEqual(planChanges(inspectHost(host)), []);
});

test('prepare with no host changes configures the owner, registers with its host and owner name, then shows status', async () => {
    const host = fakeHost({ registered: false });
    const github = fakeGitHubIo();
    const io = combinedRunnerIo(host, github);
    const output = [];
    const original = console.log;
    console.log = (message) => output.push(message);
    try {
        assert.equal(await main(['prepare'], io, {
            hostName: 'test-laptop',
            requireTerminal() {},
            async confirmChange() { return true; },
            async confirmRegistration() { return true; },
        }), 0);
    } finally {
        console.log = original;
    }
    assert.match(output.join('\n'), /No host changes required/);
    const ownerIndex = output.findIndex((line) => /Configured RUNNER_OWNER_ID/.test(line));
    const guideIndex = output.findIndex((line) => /Register the laptop runner/.test(line));
    const registeredIndex = output.findIndex((line) => /^Registered\./.test(line));
    const statusIndex = output.findIndex((line) => /registration: test-laptop-installer/.test(line));
    assert.ok(ownerIndex >= 0 && guideIndex > ownerIndex && registeredIndex > guideIndex && statusIndex > registeredIndex);
    const expectedRunnerName = 'test-laptop-installer';
    assert.equal(host.calls.filter((argv) => JSON.stringify(argv) === JSON.stringify(registrationCommand(expectedRunnerName))).length, 1);
    assert.match(output.join('\n'), new RegExp(expectedRunnerName));
    assert.match(output[statusIndex], new RegExp(`registration: ${expectedRunnerName}`));
    assert.ok(github.calls.some((argv) => argv[0] === 'gh' && argv[1] === 'api' && argv[2] === '--paginate'));
});

test('prepare stops at a failed owner configuration and prints the manual resume command', async () => {
    const host = fakeHost({ registered: false });
    const github = fakeGitHubIo({ failWrite: true });
    const io = combinedRunnerIo(host, github);
    const output = [];
    const errors = [];
    const originalLog = console.log;
    const originalError = console.error;
    console.log = (message) => output.push(message);
    console.error = (message) => errors.push(message);
    try {
        assert.equal(await main(['prepare'], io, {
            hostName: 'test-laptop',
            requireTerminal() {},
            async confirmChange() { return true; },
        }), 1);
    } finally {
        console.log = originalLog;
        console.error = originalError;
    }
    assert.match(errors.join('\n'), /Setup paused during configure-owner/);
    assert.match(errors.join('\n'), /hedgehog-runner configure-owner/);
    assert.equal(output.some((line) => /Register the laptop runner/.test(line)), false);
    assert.equal(output.some((line) => /owner routing:/.test(line)), false);
    assert.equal(host.calls.filter((argv) => JSON.stringify(argv) === JSON.stringify(registrationCommand('test-laptop-installer'))).length, 0);
});

test('prepare stops after registration is declined and does not show status', async () => {
    const host = fakeHost({ registered: false });
    const github = fakeGitHubIo();
    const io = combinedRunnerIo(host, github);
    const output = [];
    const errors = [];
    const originalLog = console.log;
    const originalError = console.error;
    console.log = (message) => output.push(message);
    console.error = (message) => errors.push(message);
    try {
        assert.equal(await main(['prepare'], io, {
            hostName: 'test-laptop',
            requireTerminal() {},
            async confirmChange() { return true; },
            async confirmRegistration() { return false; },
        }), 1);
    } finally {
        console.log = originalLog;
        console.error = originalError;
    }
    assert.match(errors.join('\n'), /Setup paused during instructions/);
    assert.match(errors.join('\n'), /hedgehog-runner instructions/);
    assert.equal(output.some((line) => /owner routing:/.test(line)), false);
    assert.equal(host.calls.filter((argv) => JSON.stringify(argv) === JSON.stringify(registrationCommand('test-laptop-installer'))).length, 0);
});

test('prepare stops when registration fails and can resume at instructions', async () => {
    const host = fakeHost({ registered: false, registrationWorks: false });
    const github = fakeGitHubIo();
    const io = combinedRunnerIo(host, github);
    const errors = [];
    const originalError = console.error;
    console.error = (message) => errors.push(message);
    try {
        assert.equal(await main(['prepare'], io, {
            hostName: 'test-laptop',
            requireTerminal() {},
            async confirmChange() { return true; },
            async confirmRegistration() { return true; },
        }), 1);
    } finally {
        console.error = originalError;
    }
    assert.match(errors.join('\n'), /Setup paused during instructions.*simulated runner registration failure/s);
    assert.match(errors.join('\n'), /hedgehog-runner instructions/);
    assert.equal(github.calls.some((argv) => argv[0] === 'gh' && argv[1] === 'api' && argv[2] === '--paginate'), false);
});

test('prepare stops if the final status cannot be displayed', async () => {
    const host = fakeHost({ registered: false });
    const github = fakeGitHubIo();
    const io = combinedRunnerIo(host, github);
    const originalRun = io.run;
    let registrationCompleted = false;
    io.exec = (argv, options) => {
        if (argv[0] === 'gh') github.exec(argv, options);
        else host.exec(argv, options);
        if (JSON.stringify(argv) === JSON.stringify(registrationCommand('test-laptop-installer'))) registrationCompleted = true;
    };
    io.run = (argv) => {
        if (registrationCompleted && argv[0] === 'getfacl') throw new Error('simulated status inspection failure');
        return originalRun(argv);
    };
    const errors = [];
    const originalError = console.error;
    console.error = (message) => errors.push(message);
    try {
        assert.equal(await main(['prepare'], io, {
            hostName: 'test-laptop',
            requireTerminal() {},
            async confirmChange() { return true; },
            async confirmRegistration() { return true; },
        }), 1);
    } finally {
        console.error = originalError;
    }
    assert.match(errors.join('\n'), /Setup paused during status.*simulated status inspection failure/s);
    assert.match(errors.join('\n'), /hedgehog-runner status/);
});

test('standalone instructions names a new registration from the configured owner and host', async () => {
    const host = fakeHost({ registered: false });
    const github = fakeGitHubIo();
    const io = combinedRunnerIo(host, github);
    const output = [];
    const original = console.log;
    console.log = (message) => output.push(message);
    try {
        assert.equal(await main(['instructions'], io, {
            interactive: true,
            hostName: 'workstation-7',
            requireTerminal() {},
            async confirmChange() { return true; },
            async confirmRegistration() { return true; },
        }), 0);
    } finally {
        console.log = original;
    }
    const expectedName = 'workstation-7-installer';
    assert.ok(host.calls.some((argv) => JSON.stringify(argv) === JSON.stringify(registrationCommand(expectedName))));
    assert.match(output.join('\n'), new RegExp(`Register as ${expectedName} for verified GitHub account @installer`));
    assert.ok(github.calls.some((argv) => argv[0] === 'gh' && argv[1] === 'api' && argv[2] === '--paginate'));
});

test('standalone instructions verifies a manually entered owner when the owner variable is unavailable', async () => {
    const host = fakeHost({ registered: false });
    const github = fakeGitHubIo({ variable: '', users: { laptopOwner: { login: 'laptopOwner', id: 98765 } } });
    const io = combinedRunnerIo(host, github);
    const output = [];
    const original = console.log;
    console.log = (message) => output.push(message);
    try {
        assert.equal(await main(['instructions'], io, {
            interactive: true,
            hostName: 'workstation-7',
            requireTerminal() {},
            async confirmChange() { return true; },
            async promptValue() { return 'laptopOwner'; },
            async confirmRegistration() { return true; },
        }), 0);
    } finally {
        console.log = original;
    }
    assert.ok(host.calls.some((argv) => JSON.stringify(argv) === JSON.stringify(registrationCommand('workstation-7-laptopowner'))));
    assert.ok(github.calls.some(([kind, url]) => kind === 'fetch' && url.endsWith('/users/laptopOwner')));
    assert.match(output.join('\n'), /@laptopOwner \(ID 98765\)/);
});

test('rename confirms removal and registration, changing only the runner registration', async () => {
    const host = fakeHost({ registered: true, registeredName: 'old-name' });
    const github = fakeGitHubIo();
    const io = combinedRunnerIo(host, github);
    const output = [];
    const original = console.log;
    console.log = (message) => output.push(message);
    try {
        assert.equal(await main(['rename'], io, {
            hostName: 'test-laptop',
            requireTerminal() {},
            async confirmChange() { return true; },
        }), 0);
    } finally {
        console.log = original;
    }
    const removalIndex = host.calls.findIndex((argv) => JSON.stringify(argv) === JSON.stringify(removalCommand()));
    const registrationIndex = host.calls.findIndex((argv) => JSON.stringify(argv) === JSON.stringify(registrationCommand('test-laptop-installer')));
    assert.ok(removalIndex >= 0 && registrationIndex > removalIndex);
    assert.match(output.join('\n'), /Runner renamed to test-laptop-installer/);
    assert.match(output.join('\n'), /workspace and caches were kept/);
    assert.equal(host.calls.some((argv) => argv[0] === 'sudo' && argv[1] === 'rm'), false);
    assert.equal(inspectHost(host).files.configured, true);
});

test('rename does not deregister when the runner is active or the change is declined', async () => {
    const runningHost = fakeHost({ registered: true, listenerRunning: true });
    const github = fakeGitHubIo();
    const runningIo = combinedRunnerIo(runningHost, github);
    const runningErrors = [];
    const originalError = console.error;
    console.error = (message) => runningErrors.push(message);
    try {
        assert.equal(await main(['rename'], runningIo, { requireTerminal() {} }), 1);
    } finally {
        console.error = originalError;
    }
    assert.match(runningErrors.join('\n'), /Stop the runner first/);
    assert.equal(runningHost.calls.some((argv) => JSON.stringify(argv) === JSON.stringify(removalCommand())), false);

    const stoppedHost = fakeHost({ registered: true, registeredName: 'old-name' });
    const stoppedIo = combinedRunnerIo(stoppedHost, fakeGitHubIo());
    let confirmationCount = 0;
    assert.equal(await main(['rename'], stoppedIo, {
        hostName: 'test-laptop',
        requireTerminal() {},
        async confirmChange() { return ++confirmationCount === 1; },
    }), 1);
    assert.equal(stoppedHost.calls.some((argv) => JSON.stringify(argv) === JSON.stringify(removalCommand())), false);
});

test('rename explains recovery when new registration fails after deregistration', async () => {
    const host = fakeHost({ registered: true, registeredName: 'old-name', registrationWorks: false });
    const io = combinedRunnerIo(host, fakeGitHubIo());
    const errors = [];
    const originalError = console.error;
    console.error = (message) => errors.push(message);
    try {
        assert.equal(await main(['rename'], io, {
            hostName: 'test-laptop',
            requireTerminal() {},
            async confirmChange() { return true; },
        }), 1);
    } finally {
        console.error = originalError;
    }
    assert.match(errors.join('\n'), /old registration was removed.*registration as test-laptop-installer did not complete/s);
    assert.match(errors.join('\n'), /hedgehog-runner instructions/);
    assert.equal(host.calls.some((argv) => argv[0] === 'sudo' && argv[1] === 'rm'), false);
});

test('prepare leaves Lingering disabled when its change is declined', async () => {
    const host = fakeHost({ linger: false });
    const output = [];
    const original = console.log;
    console.log = (message) => output.push(message);
    try {
        assert.equal(await main(['prepare'], host, {
            requireTerminal() {},
            async confirmChange() { return false; },
        }), 1);
    } finally {
        console.log = original;
    }
    assert.equal(host.calls.some((argv) => argv.join(' ') === `sudo loginctl enable-linger ${account}`), false);
    assert.match(output.join('\n'), /Remaining changes were not applied/);
});

test('prepare creates the account before separately asking to enable Lingering', async () => {
    const host = fakeHost({ prepared: false, linger: false });
    const original = console.log;
    let confirmations = 0;
    console.log = () => {};
    try {
        assert.equal(await main(['prepare'], host, {
            requireTerminal() {},
            async confirmChange() { return ++confirmations === 1; },
        }), 1);
    } finally {
        console.log = original;
    }
    assert.equal(confirmations, 2);
    assert.ok(host.calls.some((argv) => argv[0] === 'sudo' && argv[1] === 'useradd'));
    assert.equal(host.calls.some((argv) => argv.join(' ') === `sudo loginctl enable-linger ${account}`), false);
});

test('prepare enables Lingering after creating an account when both changes are confirmed', async () => {
    const host = fakeHost({ prepared: false, linger: false });
    const original = console.log;
    let confirmations = 0;
    console.log = () => {};
    try {
        assert.equal(await main(['prepare'], host, {
            requireTerminal() {},
            async confirmChange() { return ++confirmations <= 2; },
        }), 1);
    } finally {
        console.log = original;
    }
    const createIndex = host.calls.findIndex((argv) => argv[0] === 'sudo' && argv[1] === 'useradd');
    const lingerIndex = host.calls.findIndex((argv) => argv.join(' ') === `sudo loginctl enable-linger ${account}`);
    assert.ok(createIndex >= 0 && lingerIndex > createIndex);
    assert.equal(inspectHost(host).lingering.enabled, true);
});

test('prepare fails if enabling Lingering does not take effect', async () => {
    const host = fakeHost({ linger: false, enableWorks: false });
    const originalLog = console.log;
    const originalError = console.error;
    const errors = [];
    console.log = () => {};
    console.error = (message) => errors.push(message);
    try {
        assert.equal(await main(['prepare'], host, {
            requireTerminal() {},
            async confirmChange() { return true; },
        }), 1);
    } finally {
        console.log = originalLog;
        console.error = originalError;
    }
    assert.match(errors.join('\n'), /enable-lingering.*did not take effect/);
});

test('an unreadable Lingering state never counts as a fully prepared host', async () => {
    const host = fakeHost({ lingerReadable: false });
    const output = [];
    const errors = [];
    const originalLog = console.log;
    const originalError = console.error;
    console.log = (message) => output.push(message);
    console.error = (message) => errors.push(message);
    try {
        assert.equal(await main(['check'], host), 0);
        assert.equal(await main(['prepare'], host, {
            requireTerminal() {},
            async confirmChange() { return assert.fail('must not ask to apply an unknown state'); },
        }), 1);
    } finally {
        console.log = originalLog;
        console.error = originalError;
    }
    assert.match(output.join('\n'), /Lingering status.*could not be inspected/);
    assert.doesNotMatch(output.join('\n'), /No host changes required/);
    assert.match(errors.join('\n'), /Could not verify Lingering/);
});

test('prepare stops with a sudo/access hint when account directories cannot be inspected', async () => {
    const host = fakeHost({ accountDirectoryProbeFailureAt: 2 });
    const errors = [];
    const originalError = console.error;
    console.error = (message) => errors.push(message);
    try {
        assert.equal(await main(['prepare'], host, {
            requireTerminal() {},
            async confirmChange() { return assert.fail('must not plan changes from an unknown directory state'); },
        }), 1);
    } finally {
        console.error = originalError;
    }
    assert.ok(host.calls.some((argv) => argv.join(' ') === 'sudo -v'));
    assert.match(errors.join('\n'), /Could not inspect.*account-owned files/i);
    assert.match(errors.join('\n'), /already ran `sudo -v`/);
    assert.match(errors.join('\n'), /Permission denied while inspecting account directories/);
});

test('prepare stops with an access hint if account directory inspection fails after a change', async () => {
    const host = fakeHost({ prepared: false, accountDirectoryProbeFailureAt: 1 });
    const errors = [];
    const originalLog = console.log;
    const originalError = console.error;
    console.log = () => {};
    console.error = (message) => errors.push(message);
    try {
        assert.equal(await main(['prepare'], host, {
            requireTerminal() {},
            async confirmChange() { return true; },
        }), 1);
    } finally {
        console.log = originalLog;
        console.error = originalError;
    }
    assert.ok(host.calls.some((argv) => argv[0] === 'sudo' && argv[1] === 'useradd'));
    assert.match(errors.join('\n'), /Could not inspect.*account-owned files/i);
    assert.doesNotMatch(errors.join('\n'), /did not take effect/);
});

test('a fresh host plans the account, directories and pinned runner in order', () => {
    const changes = planChanges(inspectHost(fakeHost({ prepared: false })));
    assert.deepEqual(changes.map((change) => change.id),
        ['create-account', 'restrict-account-home', 'account-directories', 'install-runner']);
    const useradd = changes[0].steps[0].argv;
    assert.deepEqual(useradd.slice(0, 2), ['sudo', 'useradd']);
    assert.ok(!useradd.some((part) => /^(-G|--groups)$/.test(part)), 'no supplementary groups');
    assert.deepEqual(accountInnerCommand(changes[2].steps[0].argv), ['install', '-d', '-m', '700', ...accountDirectories]);
    assert.ok(changes[3].download);
    assert.deepEqual(changes[3].steps.map(({ argv }) => accountInnerCommand(argv)), [
        ['tar', '-xzf', '<verified-runner-archive>', '-C', runnerDirectory],
        ['chmod', '700', runnerDirectory],
        ['tee', versionMarkerPath],
    ]);
    assert.ok(changes.every((change) => change.steps.every(({ argv }) => argv[0] === 'sudo')));
});

test('runner extraction restores mode 700 after tar applies the archive directory mode', () => {
    const temporaryDirectory = mkdtempSync(join(process.cwd(), '.runner-tar-test-'));
    const sourceDirectory = join(temporaryDirectory, 'source');
    const destinationDirectory = join(temporaryDirectory, 'actions-runner');
    const archivePath = join(temporaryDirectory, 'runner.tar.gz');
    mkdirSync(sourceDirectory);
    mkdirSync(destinationDirectory);
    writeFileSync(join(sourceDirectory, 'run.sh'), '#!/bin/sh\n');
    chmodSync(sourceDirectory, 0o755);
    chmodSync(destinationDirectory, 0o700);
    try {
        const archive = spawnSync('tar', ['-czf', archivePath, '-C', sourceDirectory, '.'], { encoding: 'utf8' });
        assert.equal(archive.status, 0, archive.stderr);
        const extract = spawnSync('tar', ['-xzf', archivePath, '-C', destinationDirectory], { encoding: 'utf8' });
        assert.equal(extract.status, 0, extract.stderr);
        assert.equal(statSync(destinationDirectory).mode & 0o777, 0o755);
        const restrict = spawnSync('chmod', ['700', destinationDirectory], { encoding: 'utf8' });
        assert.equal(restrict.status, 0, restrict.stderr);
        assert.equal(statSync(destinationDirectory).mode & 0o777, 0o700);
    } finally {
        rmSync(temporaryDirectory, { recursive: true, force: true });
    }
});

test('unsafe account states block instead of being changed automatically', () => {
    for (const group of ['sudo', 'docker', 'libvirt', 'kvm', 'lxd', 'incus', 'owner']) {
        const problems = blockingProblems(inspectHost(fakeHost({ groups: `${account} ${group}` })));
        assert.equal(problems.length, 1, group);
        assert.match(problems[0], new RegExp(`gpasswd -d ${account} ${group}`));
    }
    const acl = blockingProblems(inspectHost(fakeHost({ acl: `user::rwx\nuser:${account}:r-x\nother::---\n` })));
    assert.match(acl[0], /setfacl -x u:gha-example/);
    const state = inspectHost(fakeHost());
    assert.match(blockingProblems({ ...state, account: { ...state.account, sudoAllowed: true } })[0], /may run sudo/);
});

test('owner home readable by others is planned as a confirmed non-admin change', () => {
    const [change] = planChanges(inspectHost(fakeHost({ homeMode: '755' })));
    assert.equal(change.id, 'restrict-owner-home');
    assert.equal(change.admin, false);
    assert.deepEqual(change.steps[0].argv, ['chmod', 'o-rwx', '/home/owner']);
});

test('inspection is read-only and uses only non-interactive sudo', () => {
    const host = fakeHost();
    inspectHost(host);
    for (const argv of host.calls.filter((call) => call[0] === 'sudo')) {
        assert.equal(argv[1], '-n', argv.join(' '));
        const inner = argv.includes('env') ? accountInnerCommand(argv) : argv.slice(2);
        assert.match(inner[0], /^(true|-l|cat|test|sh)$/, argv.join(' '));
    }
    const uncached = inspectHost(fakeHost({ sudoCached: false }));
    assert.equal(uncached.files.known, false);
});

test('account commands run in the account home with isolated environment, arguments and stdin', () => {
    const directory = mkdtempSync(join(dirname(fileURLToPath(import.meta.url)), '.runner-test-'));
    try {
        const home = join(directory, 'account home');
        const work = join(directory, 'owner work');
        mkdirSync(home);
        mkdirSync(work);
        const argumentsToForward = ['argument with spaces', '$(touch should-not-run)', '', 'line\nbreak'];
        const probe = 'const fs = require("node:fs"); process.stdout.write(JSON.stringify({'
            + 'cwd: process.cwd(), args: process.argv.slice(1), input: fs.readFileSync(0, "utf8"), '
            + 'home: process.env.HOME, user: process.env.USER, runtime: process.env.XDG_RUNTIME_DIR, '
            + 'ssh: process.env.SSH_AUTH_SOCK ?? null, token: process.env.GH_TOKEN ?? null, docker: process.env.DOCKER_HOST ?? null}));';
        const command = asAccount([process.execPath, '-e', probe, ...argumentsToForward], {
            nonInteractive: true, environment: { XDG_RUNTIME_DIR: '/account/runtime with spaces' },
        });
        assert.deepEqual(command.slice(0, 7), ['sudo', '-n', '-u', account, '-H', '--', 'env']);
        const envArguments = command.slice(7);
        assert.deepEqual(envArguments.slice(0, 2), ['-i', `HOME=${accountHome}`]);
        envArguments[1] = `HOME=${home}`;
        const result = spawnSync('env', envArguments, {
            cwd: work, encoding: 'utf8', input: 'interactive input\n',
            env: { ...process.env, SSH_AUTH_SOCK: 'owner-socket', GH_TOKEN: 'owner-token', DOCKER_HOST: 'owner-docker' },
        });
        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(JSON.parse(result.stdout), {
            cwd: home, args: argumentsToForward, input: 'interactive input\n', home, user: account,
            runtime: '/account/runtime with spaces', ssh: null, token: null, docker: null,
        });
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('account commands do not execute when the account home is unavailable', () => {
    const directory = mkdtempSync(join(dirname(fileURLToPath(import.meta.url)), '.runner-test-'));
    try {
        const command = asAccount([process.execPath, '-e', 'process.stdout.write("executed")']);
        const envArguments = command.slice(command.indexOf('env') + 1);
        assert.deepEqual(envArguments.slice(0, 2), ['-i', `HOME=${accountHome}`]);
        envArguments[1] = `HOME=${join(directory, 'missing')}`;
        const result = spawnSync('env', envArguments, { cwd: directory, encoding: 'utf8' });
        assert.notEqual(result.status, 0);
        assert.equal(result.stdout, '');
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('systemd runtime paths and runner environment use the actual non-root UID', () => {
    const uid = '2345';
    const runtimeDirectory = '/run/user/2345';
    assert.equal(runtimeDirectoryFor(uid), runtimeDirectory);
    assert.deepEqual(systemdUserEnvironment(uid), {
        XDG_RUNTIME_DIR: runtimeDirectory,
        DBUS_SESSION_BUS_ADDRESS: `unix:path=${runtimeDirectory}/bus`,
    });
    assert.throws(() => runtimeDirectoryFor('0'), /non-root runner UID/);
    assert.throws(() => runtimeDirectoryFor('../1001'), /non-root runner UID/);
});

test('runner start requires lingering and a reachable systemd user bus', () => {
    const prepared = fakeSystemdHost({ uid: '2345' });
    assert.deepEqual(assertSystemdUserManager(prepared), {
        uid: '2345',
        runtimeDirectory: '/run/user/2345',
        environment: {
            XDG_RUNTIME_DIR: '/run/user/2345',
            DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/2345/bus',
        },
    });
    assert.ok(prepared.calls.some((argv) => argv.includes('systemctl') && argv.includes('--user')));
    assert.throws(() => assertSystemdUserManager(fakeSystemdHost({ linger: false })), /sudo loginctl enable-linger/);
    assert.throws(() => assertSystemdUserManager(fakeSystemdHost({ runtime: false })), /runtime directory.*missing/);
    assert.throws(() => assertSystemdUserManager(fakeSystemdHost({ bus: false })), /user bus socket.*unavailable/);
    assert.throws(() => assertSystemdUserManager(fakeSystemdHost({ manager: false })), /not reachable/);
    assert.throws(() => getAccountUid({ run: () => ({ status: 0, stdout: '0\n', stderr: '' }) }), /non-root UID/);
});

test('start script requires the systemd-owned runtime and never creates or chmods it', () => {
    const script = startScriptFor();
    assert.match(script, /Systemd runtime directory/);
        assert.match(script, /\$runtime\/bus/);
        assert.doesNotMatch(script, /mkdir -p "\$runtime"|chmod 700 "\$runtime"/);
        assert.match(script, /\.\/run\.sh/);
    assert.deepEqual(startScriptArguments('2345'), ['/run/user/2345', runnerDirectory, '2345']);
});

test('check and status leave workload ports alone', async () => {
    const host = fakeHost();
    const output = [];
    const errors = [];
    const originalLog = console.log;
    const originalError = console.error;
    console.log = (message) => output.push(message);
    console.error = (message) => errors.push(message);
    try {
        assert.equal(await main(['check'], host), 0);
        assert.equal(await main(['status'], combinedRunnerIo(host, fakeGitHubIo())), 0);
        assert.equal(await main(['start'], host), 1);
    } finally {
        console.log = originalLog;
        console.error = originalError;
    }
    assert.ok(!host.calls.some((argv) => argv[0] === 'ss'));
    assert.doesNotMatch(output.join('\n'), /\bports? (busy|free)|ports: /i);
    assert.doesNotMatch(errors.join('\n'), /Ports? .*in use/);
    assert.match(errors.join('\n'), /'start' asks for confirmations/);
});

test('registration guide has seven steps, the label, and the token is never an argument', () => {
    const guide = registrationGuide('laptop-example-laptop');
    for (let step = 1; step <= 7; step++) assert.match(guide, new RegExp(`^${step}\\. `, 'm'));
    assert.match(guide, /example-laptop/);
    assert.match(guide, /settings\/actions\/runners/);
    assert.match(guide, /runner group/i);
    assert.match(guide, /organize.*runners.*control.*repositories/i);
    assert.match(guide, /Default.*press(?:ing)? Enter/i);
    assert.doesNotMatch(guide, /--token\s+[A-Za-z0-9]{8,}/);
    for (const command of [registrationCommand('laptop-example-laptop'), removalCommand()]) {
        assert.ok(!command.some((part) => /token/i.test(part)), command.join(' '));
        assert.deepEqual(command.slice(0, 6), ['sudo', '-u', account, '-H', '--', 'env']);
        assert.equal(command[6], '-i', 'owner environment is not inherited');
    }
    const registration = registrationCommand('laptop-example-laptop');
    assert.deepEqual(registration.slice(-4), [runnerDirectory, 'https://github.com/example-org/example-repo', 'laptop-example-laptop', runnerLabel]);
    assert.match(registration.at(-6), /--disableupdate/);
});

test('runner archive is rejected on checksum mismatch', () => {
    const archive = Buffer.from('runner');
    assert.doesNotThrow(() => assertDigest(archive, createHash('sha256').update(archive).digest('hex')));
    assert.throws(() => assertDigest(archive, '0'.repeat(64)), /checksum mismatch.*discarded/);
});

test('removal lists remaining GitHub and host cleanup for partial states', () => {
    const partial = removalFollowUps({ deregistered: false, accountRemoved: false });
    assert.match(partial[0], /Force remove/);
    assert.match(partial[1], /still exist/);
    assert.equal(removalFollowUps({ deregistered: true, accountRemoved: true }).length, 1);
});

test('runner removal never includes the systemd-managed runtime directory', () => {
    const command = runnerDirectoryRemovalCommand();
    assert.deepEqual(accountInnerCommand(command), ['rm', '-rf', '--one-file-system', '--', runnerDirectory]);
    assert.ok(!command.some((part) => part.startsWith('/run/user/')));
});

test('account process cleanup does nothing when no account processes are running', () => {
    const calls = [];
    const io = { run(argv) { calls.push(argv); return { status: 1, stdout: '', stderr: '' }; } };
    assert.equal(terminateAccountProcesses(io, () => assert.fail('must not wait')), true);
    assert.deepEqual(calls, [['pgrep', '-u', account]]);
});

test('account process cleanup terminates processes and waits for graceful exit', () => {
    let processesRunning = true;
    const calls = [];
    const io = {
        run(argv) {
            calls.push(argv);
            if (argv[0] === 'pgrep') return { status: processesRunning ? 0 : 1, stdout: '', stderr: '' };
            return { status: 0, stdout: '', stderr: '' };
        },
    };
    assert.equal(terminateAccountProcesses(io, () => { processesRunning = false; }), true);
    assert.deepEqual(calls, [
        ['pgrep', '-u', account],
        ['sudo', 'pkill', '-TERM', '-u', account],
        ['pgrep', '-u', account],
    ]);
});

test('account process cleanup escalates to KILL after the TERM timeout', () => {
    let processesRunning = true;
    const calls = [];
    const io = {
        run(argv) {
            calls.push(argv);
            if (argv[0] === 'pgrep') return { status: processesRunning ? 0 : 1, stdout: '', stderr: '' };
            if (argv[2] === '-KILL') processesRunning = false;
            return { status: 0, stdout: '', stderr: '' };
        },
    };
    assert.equal(terminateAccountProcesses(io, () => {}), true);
    assert.deepEqual(calls.filter((argv) => argv[0] === 'sudo'), [
        ['sudo', 'pkill', '-TERM', '-u', account],
        ['sudo', 'pkill', '-KILL', '-u', account],
    ]);
});

test('account process cleanup reports processes that survive KILL', () => {
    let processesRunning = true;
    const calls = [];
    const io = {
        run(argv) {
            calls.push(argv);
            return { status: argv[0] === 'pgrep' && processesRunning ? 0 : 1, stdout: '', stderr: '' };
        },
    };
    assert.equal(terminateAccountProcesses(io, () => {}), false);
    assert.deepEqual(calls.filter((argv) => argv[0] === 'sudo'), [
        ['sudo', 'pkill', '-TERM', '-u', account],
        ['sudo', 'pkill', '-KILL', '-u', account],
    ]);
});

test('GitHub user responses require a login and a positive numeric account ID', () => {
    assert.deepEqual(parseGitHubUser('{"login":"runner-installer","id":12345}'), {
        login: 'runner-installer', id: '12345',
    });
    assert.deepEqual(parseGitHubUser('{"login":"runner-installer","id":"12345"}'), {
        login: 'runner-installer', id: '12345',
    });
    assert.throws(() => parseGitHubUser('{bad json'), /valid GitHub user response/);
    assert.throws(() => parseGitHubUser('{"login":"runner-installer","id":0}'), /valid GitHub user response/);
    assert.throws(() => parseGitHubUser('{"login":"","id":12345}'), /valid GitHub user response/);
});

test('configure-owner works without host preparation or runner registration', async () => {
    const io = fakeGitHubIo();
    const prompts = [];
    const output = [];
    const originalLog = console.log;
    console.log = (message) => output.push(message);
    try {
        assert.equal(await main(['configure-owner'], io, {
            requireTerminal: () => {},
            confirmChange: async (question) => { prompts.push(question); return true; },
        }), 0);
    } finally {
        console.log = originalLog;
    }

    assert.match(prompts[0], /@installer.*12345/);
    assert.match(prompts[1], /RUNNER_OWNER_ID.*@installer.*12345/);
    assert.deepEqual(io.calls, [
        ['gh', '--version'],
        ['gh', 'auth', 'status'],
        ['gh', 'api', 'user'],
        ownerVariableCommand('12345'),
    ]);
    assert.match(output.join('\n'), /configured.*@installer/i);
});

test('configure-owner can resolve and confirm a different GitHub username', async () => {
    const io = fakeGitHubIo({ users: { 'another-developer': { login: 'another-developer', id: 67890 } } });
    const confirmations = [false, true];
    let promptCount = 0;
    const prompts = [];

    assert.equal(await main(['configure-owner'], io, {
        requireTerminal: () => {},
        confirmChange: async (question) => { prompts.push(question); return confirmations.shift(); },
        promptValue: async (question) => { promptCount++; assert.match(question, /GitHub username/); return 'another-developer'; },
    }), 0);

    assert.equal(promptCount, 1);
    assert.match(prompts[1], /@another-developer.*67890/);
    assert.deepEqual(io.calls, [
        ['gh', '--version'],
        ['gh', 'auth', 'status'],
        ['gh', 'api', 'user'],
        ['fetch', 'https://api.github.com/users/another-developer'],
        ownerVariableCommand('67890'),
    ]);
});

test('configure-owner resolves a username publicly and gives manual settings instructions without gh', async () => {
    const io = fakeGitHubIo({
        ghInstalled: false,
        authenticated: false,
        users: { 'another-developer': { login: 'another-developer', id: 67890 } },
    });
    const output = [];
    const originalLog = console.log;
    console.log = (message) => output.push(message);
    try {
        assert.equal(await main(['configure-owner'], io, {
            requireTerminal() {},
            confirmChange: async () => true,
            promptValue: async (question) => {
                assert.match(question, /GitHub username/);
                return 'another-developer';
            },
        }), 0);
    } finally {
        console.log = originalLog;
    }

    assert.ok(io.calls.some((argv) => argv.join(' ') === 'gh --version'));
    assert.ok(io.calls.some((argv) => argv[0] === 'fetch' && argv[1] === 'https://api.github.com/users/another-developer'));
    assert.ok(!io.calls.some((argv) => argv[0] === 'gh' && argv[1] === 'variable'));
    assert.match(output.join('\n'), /gh.*optional|optional.*gh/i);
    assert.match(output.join('\n'), /another-developer.*67890/);
    assert.match(output.join('\n'), /settings\/variables\/actions/);
    assert.match(output.join('\n'), /No repository setting was changed/);
    assert.doesNotMatch(output.join('\n'), /Configured RUNNER_OWNER_ID/);
});

test('configure-owner manual fallback is not successful until the variable is confirmed set', async () => {
    const io = fakeGitHubIo({ ghInstalled: false, authenticated: false, users: { owner: { login: 'owner', id: 67890 } } });
    const confirmations = [true, false];
    const output = [];
    const originalLog = console.log;
    console.log = (message) => output.push(message);
    try {
        assert.equal(await main(['configure-owner'], io, {
            requireTerminal() {},
            confirmChange: async (question) => {
                output.push(question);
                return confirmations.shift();
            },
            promptValue: async () => 'owner',
        }), 1);
    } finally {
        console.log = originalLog;
    }
    assert.match(output.join('\n'), /Have you set RUNNER_OWNER_ID to 67890/);
    assert.match(output.join('\n'), /run `hedgehog-runner configure-owner` again to continue/);
    assert.equal(io.calls.some((argv) => argv[0] === 'gh' && argv[1] === 'variable'), false);
});

test('configure-owner uses the public lookup when gh is installed but unauthenticated', async () => {
    const io = fakeGitHubIo({
        authenticated: false,
        users: { 'another-developer': { login: 'another-developer', id: 67890 } },
    });
    const output = [];
    const originalLog = console.log;
    console.log = (message) => output.push(message);
    try {
        assert.equal(await main(['configure-owner'], io, {
            requireTerminal() {},
            confirmChange: async () => true,
            promptValue: async () => 'another-developer',
        }), 0);
    } finally {
        console.log = originalLog;
    }

    assert.ok(io.calls.some((argv) => argv.join(' ') === 'gh auth status'));
    assert.ok(io.calls.some((argv) => argv[0] === 'fetch' && argv[1] === 'https://api.github.com/users/another-developer'));
    assert.ok(!io.calls.some((argv) => argv[0] === 'gh' && argv[1] === 'api' && argv[2] === 'user'));
    assert.ok(!io.calls.some((argv) => argv[0] === 'gh' && argv[1] === 'variable'));
    assert.match(output.join('\n'), /not authenticated.*optional/i);
    assert.match(output.join('\n'), /No repository setting was changed/);
});

test('configure-owner does not provide manual setup instructions until the public identity is confirmed', async () => {
    const io = fakeGitHubIo({
        ghInstalled: false,
        authenticated: false,
        users: { 'another-developer': { login: 'another-developer', id: 67890 } },
    });
    const output = [];
    const originalLog = console.log;
    console.log = (message) => output.push(message);
    try {
        assert.equal(await main(['configure-owner'], io, {
            requireTerminal() {},
            confirmChange: async () => false,
            promptValue: async () => 'another-developer',
        }), 1);
    } finally {
        console.log = originalLog;
    }

    assert.ok(!io.calls.some((argv) => argv[0] === 'gh' && argv[1] === 'variable'));
    assert.doesNotMatch(output.join('\n'), /settings\/variables\/actions/);
});

test('status shows the stored owner ID and resolves its public account name', async () => {
    const host = fakeHost();
    const github = fakeGitHubIo({
        users: { installer: { login: 'installer', id: 12345 } },
        variable: '12345\n',
    });
    const io = {
        ...host,
        ...github,
        run(argv) { return argv[0] === 'gh' ? github.run(argv) : host.run(argv); },
    };
    const output = [];
    const originalLog = console.log;
    console.log = (message) => output.push(message);
    try {
        assert.equal(await main(['status'], io), 0);
    } finally {
        console.log = originalLog;
    }

    assert.match(output.join('\n'), /owner routing: @installer \(ID 12345\)/i);
    assert.ok(io.calls.some((argv) => argv[0] === 'gh' && argv.includes('--paginate')));
    assert.ok(io.calls.some((argv) => argv[0] === 'fetch' && argv[1] === 'https://api.github.com/user/12345'));
    assert.ok(!io.calls.some((argv) => argv[0] === 'gh' && argv[1] === 'variable' && argv.includes('set')));
});

test('status distinguishes a missing owner variable from an unreadable variable', async () => {
    for (const { options, expected, unexpected } of [
        { options: { variable: '' }, expected: /owner routing: not configured/i, unexpected: /owner routing: unknown/i },
        { options: { failVariableRead: true }, expected: /owner routing: unknown/i, unexpected: /owner routing: not configured/i },
        { options: { variable: 'invalid' }, expected: /owner routing: invalid ID/i, unexpected: /owner routing: not configured/i },
        { options: { variable: '12345', failLookup: true }, expected: /owner routing: ID 12345.*account name unavailable/i, unexpected: /owner routing: not configured/i },
        { options: { variable: '67890' }, expected: /owner routing: ID 67890.*account name unavailable.*instead of 67890/i, unexpected: /owner routing: not configured/i },
    ]) {
        const host = fakeHost();
        const github = fakeGitHubIo(options);
        const io = {
            ...host,
            ...github,
            run(argv) { return argv[0] === 'gh' ? github.run(argv) : host.run(argv); },
        };
        const output = [];
        const originalLog = console.log;
        console.log = (message) => output.push(message);
        try {
            assert.equal(await main(['status'], io), 0);
        } finally {
            console.log = originalLog;
        }
        assert.match(output.join('\n'), expected);
        assert.doesNotMatch(output.join('\n'), unexpected);
        assert.doesNotMatch(output.join('\n'), /install GitHub CLI|authenticate gh/i);
    }
});

test('configure-owner cancellation never writes a repository variable', async () => {
    const io = fakeGitHubIo();
    const confirmations = [true, false];
    assert.equal(await main(['configure-owner'], io, {
        requireTerminal: () => {},
        confirmChange: async () => confirmations.shift(),
    }), 1);
    assert.deepEqual(io.calls, [['gh', '--version'], ['gh', 'auth', 'status'], ['gh', 'api', 'user']]);
});

test('configure-owner reports gh lookup and repository permission errors without claiming success', async () => {
    const errors = [];
    const originalError = console.error;
    console.error = (message) => errors.push(message);
    try {
        const missingUsername = fakeGitHubIo({ failLookup: true });
        const confirmations = [false];
        assert.equal(await main(['configure-owner'], missingUsername, {
            requireTerminal: () => {},
            confirmChange: async () => confirmations.shift(),
            promptValue: async () => 'unknown-account',
        }), 1);

        const permissionDenied = fakeGitHubIo({ failWrite: true });
        assert.equal(await main(['configure-owner'], permissionDenied, {
            requireTerminal: () => {},
            confirmChange: async () => true,
        }), 1);
    } finally {
        console.error = originalError;
    }

    assert.match(errors[0], /resolve GitHub username @unknown-account.*public API.*HTTP 404/i);
    assert.match(errors[1], /RUNNER_OWNER_ID.*write did not report success/i);
    assert.match(errors[1], /settings\/variables\/actions/);
});

test('check succeeds after diagnosis when setup is pending or account files are not inspectable', async () => {
    const output = [];
    const original = console.log;
    console.log = (message) => output.push(message);
    try {
        assert.equal(await main(['check'], fakeHost()), 0);
        assert.equal(await main(['check'], fakeHost({ prepared: false })), 0);
        assert.equal(await main(['check'], fakeHost({ homeMode: '755' })), 0);
        assert.equal(await main(['check'], fakeHost({ sudoCached: false })), 0);
        assert.equal(await main(['check'], fakeHost({ groups: `${account} docker` })), 1);
        assert.equal(await main(['unknown'], fakeHost()), 1);
    } finally {
        console.log = original;
    }
    assert.match(output[0], /No host changes required/);
    assert.match(output[1], /Setup incomplete: \d+ planned changes remain/);
    assert.match(output[2], /Setup incomplete: 1 planned change remains/);
    assert.match(output[3], /account files of gha-example not inspected/);
    assert.match(output[3], /Setup status incomplete: account-owned files were not inspected/);
    assert.doesNotMatch(output[3], /No host changes required/);
    assert.match(output[4], /Blocking problems found/);
});

test('help aliases explain every command without inspecting or changing the host', async () => {
    const output = [];
    const errors = [];
    const originalLog = console.log;
    const originalError = console.error;
    console.log = (message) => output.push(message);
    console.error = (message) => errors.push(message);
    const host = fakeHost();
    try {
        for (const command of ['help', '--help', '-h']) {
            assert.equal(await main([command], host), 0);
        }
    } finally {
        console.log = originalLog;
        console.error = originalError;
    }

    const helpText = output[0];
    const help = helpText.replace(/\s+/g, ' ');
    assert.ok(helpText.split('\n').every((line) => line.length <= 88), 'help lines should fit a typical terminal width');
    for (const command of ['check', 'prepare', 'instructions', 'configure-owner', 'rename', 'status', 'start', 'stop', 'remove']) {
        assert.match(help, new RegExp(`\\b${command}\\b`));
    }
    assert.match(help, new RegExp(ownerVariableName));
    assert.deepEqual(host.calls, []);
    assert.deepEqual(errors, []);
});


test('prepare skips the owner feature when disabled and uses a local runner name', async () => {
    const host = fakeHost();
    const runner = createRunner({ ...config, configureOwner: false, runnerName: 'local-laptop' });
    const result = await runner.main(['prepare'], host, {
        requireTerminal() {},
        async confirmRegistration() { return true; },
        async promptValue() { assert.fail('A local runner name should be sufficient'); },
    });
    assert.equal(result, 0);
    assert.ok(host.calls.some((argv) => argv.at(-2) === 'local-laptop'));
    assert.ok(!host.calls.some((argv) => argv[0] === 'gh'));
});

test('prepare rejects a registration that belongs to another repository', async () => {
    const host = fakeHost({ registered: true, registrationUrl: 'https://github.com/unrelated/other' });
    assert.equal(await main(['prepare'], host, {
        requireTerminal() {},
        async confirmChange() { assert.fail('A mismatched registration should stop setup'); },
    }), 1);
    assert.ok(!host.calls.some((argv) => argv[0] === 'gh' || argv[1] === 'useradd'));
});
