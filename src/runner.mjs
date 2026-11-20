/** Guided lifecycle for a repository-scoped GitHub Actions runner on Ubuntu. */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { hostname, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { loadConfig } from './config.mjs';

export function createRunner(config) {
    const { account, configureOwner, jobEnv, labels, repository, runnerName: localRunnerName } = config;
    const accountHome = `/home/${account}`;
    const runnerLabel = labels.join(',');
    const repositoryUrl = `https://github.com/${repository}`;
    const ownerVariableName = 'RUNNER_OWNER_ID';
    const ownerVariableSettingsUrl = `${repositoryUrl}/settings/variables/actions`;
    const runnersSettingsUrl = `${repositoryUrl}/settings/actions/runners`;
    // Upgrade version, URL and digest together after verifying the upstream release.
    const runnerVersion = '2.338.2';
    const runnerDigest = 'baebf204307bac6193480852732f0aba2ae97b6c5597c244f4d5558390147c40';
    const runnerUrl = `https://github.com/actions/runner/releases/download/v${runnerVersion}/actions-runner-linux-x64-${runnerVersion}.tar.gz`;
    const runnerDirectory = `${accountHome}/actions-runner`;
    const versionMarkerPath = `${runnerDirectory}/.hedgehog-runner-version`;
    // Preserve registrations from the original zwoPRO helper during migration.
    const legacyVersionMarkerPath = `${runnerDirectory}/.zwopro-runner-version`;
    const accountDirectories = [runnerDirectory];
    const privilegedGroups = ['sudo', 'admin', 'wheel', 'docker', 'libvirt', 'kvm', 'lxd', 'incus'];
    const versionMarker = `${runnerVersion} ${runnerDigest}\n`;
    const archivePlaceholder = '<verified-runner-archive>';
    const requiredTools = [{ commands: ['getfacl'], package: 'acl' }];
    const accountPath = '/usr/local/bin:/usr/bin:/bin';
    const listenerPattern = 'Runner.Listener';

    function runtimeDirectoryFor(uid) {
        if (!/^\d+$/.test(String(uid)) || String(uid) === '0') throw new Error(`Invalid non-root runner UID: ${uid}`);
        return `/run/user/${uid}`;
    }

    function systemdUserEnvironment(uid) {
        const runtimeDirectory = runtimeDirectoryFor(uid);
        return {
            XDG_RUNTIME_DIR: runtimeDirectory,
            DBUS_SESSION_BUS_ADDRESS: `unix:path=${runtimeDirectory}/bus`,
        };
    }

    /** Keep unrelated settings and replace the previous CLI-managed block on restart. */
    function runnerEnvFile(existing) {
        const begin = '# BEGIN HEDGEHOG RUNNER';
        const end = '# END HEDGEHOG RUNNER';
        const lines = (existing ?? '').split(/\r?\n/);
        const first = lines.indexOf(begin);
        const last = lines.indexOf(end);
        if (first !== -1 || last !== -1) {
            if (first < 0 || last <= first || lines.lastIndexOf(begin) !== first || lines.lastIndexOf(end) !== last) {
                throw new Error('Malformed Hedgehog Runner section in the runner .env file.');
            }
            lines.splice(first, last - first + 1);
        }
        if (Object.keys(jobEnv).length) {
            while (lines.at(-1) === '') lines.pop();
            lines.push(begin, ...Object.entries(jobEnv).map(([key, value]) => `${key}=${value}`), end, '');
        }
        return lines.join('\n');
    }

    function getAccountUid(io) {
        const result = io.run(['id', '-u', account]);
        const uid = result.stdout.trim();
        if (result.status !== 0 || !/^\d+$/.test(uid) || uid === '0') {
            throw new Error(`Could not resolve a non-root UID for ${account}; run \`hedgehog-runner setup\` to create the service account first.`);
        }
        return uid;
    }

    function assertSystemdUserManager(io) {
        const uid = getAccountUid(io);
        const runtimeDirectory = runtimeDirectoryFor(uid);
        const environment = systemdUserEnvironment(uid);
        const linger = io.run(['sudo', '-n', 'loginctl', 'show-user', account, '--property=Linger', '--value']);
        if (linger.status !== 0 || linger.stdout.trim() !== 'yes') {
            throw new Error(`Lingering is not enabled for ${account}. After approving this host change, run `
                + `\`sudo loginctl enable-linger ${account}\` in a terminal, then retry. This helper did not change it.`);
        }

        const runtime = io.run(asAccount(['stat', '-c', '%u:%a', runtimeDirectory], { nonInteractive: true, environment }));
        if (runtime.status !== 0 || runtime.stdout.trim() !== `${uid}:700`) {
            throw new Error(`Systemd runtime directory ${runtimeDirectory} is missing or has unexpected ownership/mode; `
                + `verify Lingering with \`loginctl show-user ${account} -p Linger\` and retry after the user manager starts.`);
        }
        const busPath = `${runtimeDirectory}/bus`;
        const bus = io.run(asAccount(['test', '-S', busPath], { nonInteractive: true, environment }));
        if (bus.status !== 0) {
            throw new Error(`The systemd user bus socket ${busPath} is unavailable; verify the user manager for ${account} `
                + 'is running before starting the runner.');
        }
        const manager = io.run(asAccount(['systemctl', '--user', 'show-environment'], { nonInteractive: true, environment }));
        if (manager.status !== 0) {
            throw new Error(`The systemd user manager for ${account} is not reachable through ${busPath}; `
                + 'inspect its logind session and D-Bus bus before retrying.');
        }
        return { uid, runtimeDirectory, environment };
    }

    function runnerDirectoryRemovalCommand() {
        return asAccount(['rm', '-rf', '--one-file-system', '--', runnerDirectory]);
    }

    /**
     * Builds a command executed as the service account with an empty environment,
     * so owner variables (SSH agent, GitHub CLI tokens, DOCKER_HOST) never leak.
     * Start in the account home rather than the owner's potentially inaccessible cwd.
     */
    function asAccount(argv, { nonInteractive = false, environment = {} } = {}) {
        return [
            'sudo', ...(nonInteractive ? ['-n'] : []), '-u', account, '-H', '--', 'env', '-i',
            `HOME=${accountHome}`, `USER=${account}`, `LOGNAME=${account}`, `PATH=${accountPath}`, 'LANG=C.UTF-8',
            ...Object.entries(environment).map(([name, value]) => `${name}=${value}`),
            'sh', '-c', 'cd "$HOME" && exec "$@"', 'sh', ...argv,
        ];
    }

    /** Stops all remaining processes owned by the runner account before account deletion. */
    function terminateAccountProcesses(io, wait = (milliseconds) => spawnSync('sleep', [String(milliseconds / 1000)])) {
        const hasProcesses = () => {
            const result = io.run(['pgrep', '-u', account]);
            if (result.status === 0) return true;
            if (result.status === 1) return false;
            throw new Error(`Could not inspect processes owned by ${account}: ${result.stderr.trim()}`);
        };
        const waitForExit = (timeout) => {
            for (let elapsed = 0; elapsed < timeout; elapsed += 250) {
                wait(250);
                if (!hasProcesses()) return true;
            }
            return !hasProcesses();
        };

        if (!hasProcesses()) return true;
        io.run(['sudo', 'pkill', '-TERM', '-u', account]);
        if (waitForExit(10_000)) return true;
        io.run(['sudo', 'pkill', '-KILL', '-u', account]);
        return waitForExit(2_000);
    }

    function formatCommand(argv) {
        return argv.map((part) => /^[\w@%+=:,./<>-]+$/.test(part) ? part : `'${part.replaceAll("'", "'\\''")}'`).join(' ');
    }

    function parseOsRelease(text) {
        const values = Object.fromEntries(text.split('\n')
            .map((line) => /^([A-Z_]+)=(.*)$/.exec(line.trim()))
            .filter(Boolean)
            .map(([, key, value]) => [key, value.replace(/^"(.*)"$/, '$1')]));
        return { id: values.ID ?? '', versionId: values.VERSION_ID ?? '', prettyName: values.PRETTY_NAME ?? '' };
    }

    function assertSupportedPlatform({ os, arch, platform }) {
        if (platform !== 'linux' || os.id !== 'ubuntu' || arch !== 'x64') {
            const found = `${os.prettyName || platform} ${arch}`;
            throw new Error(`Unsupported host (${found}). Hedgehog Runner supports Ubuntu Linux x86_64 only `
                + '(tested on Ubuntu 26.04). Use another runner on other platforms.');
        }
    }

    function parseSudoList(output) {
        return /may run the following commands/i.test(output);
    }

    function assertDigest(buffer, expected) {
        const actual = createHash('sha256').update(buffer).digest('hex');
        if (actual !== expected) throw new Error(`Runner archive checksum mismatch (expected ${expected}, got ${actual}); the download was discarded.`);
    }

    /** Problems that require a human decision; the script never fixes them automatically. */
    function blockingProblems(state) {
        const problems = [];
        if (state.account.exists && (!state.account.uid || state.account.home !== accountHome)) {
            problems.push(`Account ${account} must have a non-root UID and home ${accountHome}.`);
        }
        const forbidden = new Set([...privilegedGroups, state.owner.group]);
        for (const group of state.account.groups.filter((name) => forbidden.has(name) && name !== account)) {
            problems.push(`Account ${account} is a member of '${group}'. Remove it manually: sudo gpasswd -d ${account} ${group}`);
        }
        if (state.account.sudoAllowed) {
            problems.push(`Account ${account} may run sudo. Remove its sudoers entry manually (sudo visudo / /etc/sudoers.d).`);
        }
        for (const entry of state.owner.acl.split('\n')) {
            const [type, name, permissions] = entry.trim().split(':');
            if ((type === 'user' || type === 'group') && name === account && permissions && permissions !== '---') {
                problems.push(`The ACL of ${state.owner.home} grants ${account} access (${entry.trim()}). Remove it manually: setfacl -x ${type[0]}:${account} ${state.owner.home}`);
            }
        }
        return problems;
    }

    /**
     * Ordered, idempotent list of missing host changes. A fully prepared host
     * yields an empty list. Commands are both displayed and executed.
     */
    function planChanges(state) {
        const changes = [];
        const missingPackages = [...new Set(state.tools.filter((tool) => !tool.present).map((tool) => tool.package))];
        if (missingPackages.length) {
            changes.push({ id: 'install-packages', admin: true, summary: `Install missing packages: ${missingPackages.join(', ')}`,
                steps: [{ argv: ['sudo', 'apt-get', 'install', '-y', '--no-install-recommends', ...missingPackages] }] });
        }
        if (!/^[0-7]?[0-7][0-7]0$/.test(state.owner.homeMode)) {
            changes.push({ id: 'restrict-owner-home', admin: false, summary: `Remove access by other users to ${state.owner.home}`,
                steps: [{ argv: ['chmod', 'o-rwx', state.owner.home] }] });
        }
        if (!state.account.exists) {
            changes.push({ id: 'create-account', admin: true, summary: `Create unprivileged account ${account} (own group, no sudo)`,
                steps: [{ argv: ['sudo', 'useradd', '--create-home', '--home-dir', accountHome, '--user-group', '--shell', '/bin/bash', account] }] });
        }
        if (state.lingering.known && !state.lingering.enabled) {
            changes.push({ id: 'enable-lingering', admin: true,
                summary: `Enable persistent systemd Lingering for ${account} (user manager starts at boot; runner does not)`,
                steps: [{ argv: ['sudo', 'loginctl', 'enable-linger', account] }] });
        }
        if (state.account.homeMode !== '700') {
            changes.push({ id: 'restrict-account-home', admin: true, summary: `Restrict ${accountHome} to mode 700`,
                steps: [{ argv: asAccount(['chmod', '700', accountHome]) }] });
        }
        const directories = accountDirectories;
        const missing = directories.filter((path) => !(path in state.files.directories));
        const wrongMode = directories.filter((path) => path in state.files.directories && state.files.directories[path] !== '700');
        if (missing.length || wrongMode.length) {
            changes.push({ id: 'account-directories', admin: true,
                summary: 'Create protected runner directories (mode 700)',
                steps: [
                    ...(missing.length ? [{ argv: asAccount(['install', '-d', '-m', '700', ...missing]) }] : []),
                    ...(wrongMode.length ? [{ argv: asAccount(['chmod', '700', ...wrongMode]) }] : []),
                ] });
        }
        if (state.files.versionMarker !== versionMarker) {
            changes.push({ id: 'install-runner', admin: true, download: true,
                summary: `Install GitHub Actions runner ${runnerVersion} (pinned, SHA-256 verified) into ${runnerDirectory}`,
                steps: [
                    { argv: asAccount(['tar', '-xzf', archivePlaceholder, '-C', runnerDirectory]) },
                    { argv: asAccount(['chmod', '700', runnerDirectory]) },
                    { argv: asAccount(['tee', versionMarkerPath]), input: versionMarker },
                ] });
        }
        return changes;
    }

    function renderChange(change, index, total) {
        const lines = [`[${index}/${total}] ${change.summary}${change.admin ? ' (uses sudo)' : ''}`];
        if (change.download) lines.push(`    download ${runnerUrl}`, `    verify SHA-256 ${runnerDigest}`);
        for (const step of change.steps) {
            lines.push(`    $ ${formatCommand(step.argv)}${step.input ? `  <<< ${JSON.stringify(step.input)}` : ''}`);
        }
        return lines.join('\n');
    }

    function runnerName(host = hostname(), login) {
        if (typeof login !== 'string' || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(login)) {
            throw new Error('A valid GitHub login is required to name the runner.');
        }
        const normalizedHost = host.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        if (!normalizedHost) throw new Error('A valid host name is required to name the runner.');
        const normalizedLogin = login.toLowerCase();
        const hostLength = 63 - normalizedLogin.length - 1;
        let shortenedHost = normalizedHost;
        if (normalizedHost.length > hostLength) {
            const hostHash = createHash('sha256').update(normalizedHost).digest('hex').slice(0, 6);
            const hostPrefix = normalizedHost.slice(0, hostLength - hostHash.length - 1).replace(/-+$/g, '');
            shortenedHost = `${hostPrefix}-${hostHash}`;
        }
        if (!shortenedHost) throw new Error('The host name is too long to form a unique runner name.');
        return `${shortenedHost}-${normalizedLogin}`;
    }

    /** `config.sh` prompts for the token itself; it is never an argument, file or environment value. */
    function registrationCommand(name) {
        if (typeof name !== 'string' || !name) throw new Error('A runner name is required for registration.');
        return asAccount(['sh', '-c', 'cd "$1" && exec ./config.sh --url "$2" --name "$3" --labels "$4" --work _work --disableupdate',
            'sh', runnerDirectory, repositoryUrl, name, runnerLabel]);
    }

    function removalCommand() {
        return asAccount(['sh', '-c', 'cd "$1" && exec ./config.sh remove', 'sh', runnerDirectory]);
    }

    function registrationGuide(name = localRunnerName ?? `${hostname().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}-<github-login>`) {
        return [
            `Register the laptop runner (repository-scoped, label ${runnerLabel})`,
            '',
            ...(configureOwner ? ['Use `hedgehog-runner configure-owner` to set RUNNER_OWNER_ID for workflows that use it.', ''] : []),
            `1. Open ${runnersSettingsUrl} and choose "New self-hosted runner".`,
            '2. Select "Linux" and architecture "x64". Skip GitHub\'s download/extract commands: `hedgehog-runner setup` already installed the pinned, checksum-verified runner.',
            '3. In GitHub\'s "Configure" block, copy only the value after `--token`. It is a short-lived registration token (about one hour); do not paste it into files, chats or tickets.',
            `4. Answer "y" below. The script runs config.sh as ${account} with --url ${repositoryUrl}, --name ${name}, --labels ${runnerLabel} and --disableupdate. The name identifies the runner in GitHub. Paste the token only when config.sh asks for it. If config.sh asks for a runner group, groups organize self-hosted runners for an organization or enterprise and control which repositories may use them. This is separate from the ${runnerLabel} label. For this repository-scoped runner, accept the offered "Default" group by pressing Enter; do not type a new group. GitHub then stores the runner's own credentials in ${runnerDirectory}; the registration token itself is not stored.`,
            '5. Lingering is handled during `setup`; after the guided registration and status steps complete, start the runner in a dedicated terminal with `hedgehog-runner start` and keep that terminal open while jobs are queued or running.',
            `6. Check on the page from step 1 that ${name} is "Idle" with the labels self-hosted, Linux, X64 and ${runnerLabel}.`,
            '7. Stop with Ctrl+C in that terminal (or `hedgehog-runner stop`). To deregister, open the runner on GitHub, choose "Remove", copy the removal token and run `hedgehog-runner remove`.',
        ].join('\n');
    }

    function removalFollowUps({ deregistered, accountRemoved }) {
        return [
            deregistered
                ? `Verify on ${runnersSettingsUrl} that the runner is gone.`
                : `Open ${runnersSettingsUrl}, select the offline runner and choose "Remove" → "Force remove this runner".`,
            ...(accountRemoved ? [] : [`Account ${account} and its data still exist; rerun remove and confirm account removal to delete them.`]),
        ];
    }

    function normalizedGitHubId(value) {
        const id = String(value ?? '');
        if (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id))) return undefined;
        return id;
    }

    function parseGitHubUser(response) {
        let user;
        try { user = JSON.parse(response); } catch { user = undefined; }
        const login = user?.login;
        const id = normalizedGitHubId(user?.id);
        if (typeof login !== 'string' || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(login) || !id) {
            throw new Error('GitHub returned no valid GitHub user response.');
        }
        return { login, id };
    }

    function ownerVariableCommand(ownerId) {
        const id = normalizedGitHubId(ownerId);
        if (!id) throw new Error('A positive numeric GitHub account ID is required.');
        return ['gh', 'variable', 'set', ownerVariableName, '--body', id, '--repo', repository];
    }

    function ownerVariableQueryCommand() {
        const filter = `.variables[] | select(.name == "${ownerVariableName}") | .value`;
        return ['gh', 'api', '--paginate', `repos/${repository}/actions/variables`, '--jq', filter];
    }

    async function promptValue(question) {
        const prompt = createInterface({ input: process.stdin, output: process.stdout });
        try {
            return await prompt.question(question);
        } finally {
            prompt.close();
        }
    }

    function queryGitHubUser(io, endpoint, description) {
        const response = io.run(['gh', 'api', endpoint]);
        if (response.status !== 0) {
            throw new Error(`Could not ${description} with GitHub CLI (\`gh api ${endpoint}\`). `
                + 'Check `gh auth status` or use the manual Actions-variable setup in the runner runbook. No setting was changed.');
        }
        return parseGitHubUser(response.stdout);
    }

    async function queryPublicGitHubUser(io, endpoint, description) {
        let response;
        try {
            response = await io.fetch(`https://api.github.com/${endpoint}`, {
                headers: { Accept: 'application/vnd.github+json' },
            });
        } catch (error) {
            throw new Error(`Could not ${description} through GitHub's public API. Check the network and retry. `
                + `No repository setting was changed. ${error instanceof Error ? error.message : String(error)}`);
        }
        if (!response.ok) {
            throw new Error(`Could not ${description} through GitHub's public API (HTTP ${response.status}). `
                + 'Check the username, network or GitHub API rate limit. No repository setting was changed.');
        }
        return parseGitHubUser(await response.text());
    }

    async function resolveRunnerOwner(io, { owner, confirmChange = confirm, promptValue: requestValue = promptValue } = {}) {
        if (owner) return owner;

        const variable = configureOwner ? io.run(ownerVariableQueryCommand()) : { status: 1 };
        const ownerId = variable.status === 0 ? normalizedGitHubId(variable.stdout.trim()) : undefined;
        if (ownerId) {
            try {
                const configuredUser = await queryPublicGitHubUser(io, `user/${encodeURIComponent(ownerId)}`, `resolve ${ownerVariableName}`);
                if (configuredUser.id !== ownerId) throw new Error(`GitHub returned account ID ${configuredUser.id} instead of ${ownerId}.`);
                if (await confirmChange(`Use configured runner owner @${configuredUser.login} (ID ${ownerId}) in the runner name?`)) {
                    return configuredUser;
                }
            } catch (error) {
                console.log(`Could not resolve ${ownerVariableName} for the runner name: ${error instanceof Error ? error.message : String(error)}`);
            }
        } else if (configureOwner) {
            console.log(`Could not read a valid ${ownerVariableName}; enter the GitHub login to include in the runner name.`);
        }

        const login = (await requestValue('GitHub username to include in the runner name: ')).trim();
        if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(login)) {
            throw new Error('Enter a valid GitHub username; no runner registration was changed.');
        }
        const selectedUser = await queryPublicGitHubUser(io, `users/${encodeURIComponent(login)}`, `resolve GitHub username @${login}`);
        if (!await confirmChange(`Use verified GitHub account @${selectedUser.login} (ID ${selectedUser.id}) in the runner name?`)) {
            throw new Error('Runner naming was not confirmed; no registration was changed.');
        }
        return selectedUser;
    }

    function runnerRegistration(io) {
        const runnerFile = io.run(asAccount(['cat', `${runnerDirectory}/.runner`], { nonInteractive: true }));
        if (runnerFile.status !== 0) return undefined;
        try {
            const { agentName, gitHubUrl } = JSON.parse(runnerFile.stdout.replace(/^\uFEFF/, ''));
            if (typeof agentName === 'string' && typeof gitHubUrl === 'string') return { agentName, gitHubUrl };
        } catch { /* Report malformed runner metadata without exposing its contents. */ }
        return { agentName: undefined, gitHubUrl: undefined };
    }
    function assertMatchingRegistration(io, state) {
        if (!state.files.configured) return;
        const registration = runnerRegistration(io);
        if (!registration?.gitHubUrl) {
            throw new Error(`Could not read valid registration metadata from ${runnerDirectory}/.runner `
                + `as ${account}; cannot verify the target repository ${repositoryUrl}. No runner changes were made.`);
        }
        if (registration?.gitHubUrl?.replace(/\/$/, '').toLowerCase() !== repositoryUrl.toLowerCase()) {
            throw new Error(`Existing runner registration does not match ${repositoryUrl}. `
                + `Registered repository: ${registration.gitHubUrl}. Account: ${account}. Directory: ${runnerDirectory}. `
                + 'Check your configuration, local profile or --account selection. No runner changes were made.');
        }
    }

    function manualOwnerVariableSteps(user) {
        return [
            `Open ${ownerVariableSettingsUrl}.`,
            `Create or update the repository Actions variable \`${ownerVariableName}\`.`,
            `Use GitHub account @${user.login} (ID ${user.id}); enter \`${user.id}\` as the variable value.`,
            'The account managing variables needs Actions variables write access.',
        ].join('\n');
    }

    async function renderOwnerStatus(io) {
        const result = io.run(ownerVariableQueryCommand());
        if (result.status !== 0) {
            return `owner routing: unknown (could not read repository variable; check GitHub access or ${ownerVariableSettingsUrl})`;
        }

        const value = result.stdout.trim();
        if (!value) return `owner routing: not configured (${ownerVariableName} is missing)`;
        const id = normalizedGitHubId(value);
        if (!id) return `owner routing: invalid ID in ${ownerVariableName} (${JSON.stringify(value)})`;

        try {
            const user = await queryPublicGitHubUser(io, `user/${encodeURIComponent(id)}`, `resolve GitHub account ID ${id}`);
            if (user.id !== id) throw new Error(`GitHub returned account ID ${user.id} instead of ${id}.`);
            return `owner routing: @${user.login} (ID ${id})`;
        } catch (error) {
            return `owner routing: ID ${id} (GitHub account name unavailable: ${error instanceof Error ? error.message : String(error)})`;
        }
    }

    function renderCheck(state, changes, problems) {
        const mark = (ok) => ok ? 'ok  ' : 'todo';
        const lines = [
            `ok   platform ${state.os.prettyName} ${state.arch}`,
            ...state.tools.map((tool) => `${mark(tool.present)} ${tool.commands.join(' or ')} (${tool.package})`),
            `${mark(state.account.exists)} account ${account}${state.account.exists ? ` groups: ${state.account.groups.join(' ')}` : ' missing'}`,
            `${mark(/0$/.test(state.owner.homeMode))} owner home ${state.owner.home} mode ${state.owner.homeMode}`,
        ];
        if (state.account.exists && !state.files.known) {
            const detail = state.files.error ? `: ${state.files.error}` : ' (sudo not cached)';
            lines.push(`info account files of ${account} not inspected${detail}; run \`sudo -v\` and retry; setup will stop rather than guess`);
        } else if (state.account.exists) {
            lines.push(`${mark(state.files.configured)} runner ${state.files.configured ? 'registered' : 'not registered (see `hedgehog-runner instructions`)'}`);
        }
        lines.push(state.lingering.known
            ? `${mark(state.lingering.enabled)} Lingering ${state.lingering.enabled ? 'enabled' : 'disabled'}`
            : 'info Lingering status could not be inspected; run `sudo -v` and retry or inspect the systemd linger directory');
        for (const problem of problems) lines.push(`FAIL ${problem}`);
        if (problems.length) lines.push('', 'Blocking problems found; resolve them manually before preparing or starting the runner.');
        if (!state.files.known) {
            lines.push('', 'Setup status incomplete: account-owned files were not inspected; no conclusion about their required changes can be made.');
        } else if (!state.lingering.known) {
            lines.push('', 'Setup status incomplete: Lingering could not be inspected; no complete conclusion about required changes can be made.');
        } else if (changes.length) {
            const remaining = changes.length === 1 ? 'change remains' : 'changes remain';
            lines.push('', `Setup incomplete: ${changes.length} planned ${remaining}`
                + ' (apply with `hedgehog-runner setup` in a terminal):');
        } else if (problems.length) {
            lines.push('', 'No setup changes are planned; resolve the blocking problems before using the runner.');
        } else {
            lines.push('', 'No host changes required.');
        }
        changes.forEach((change, index) => lines.push(renderChange(change, index + 1, changes.length)));
        return lines.join('\n');
    }

    /** Read-only inspection using non-interactive sudo for account files. */
    function inspectHost(io) {
        const os = parseOsRelease(io.readText('/etc/os-release') ?? '');
        const state = { os, arch: io.arch, platform: io.platform };
        assertSupportedPlatform(state);
        const ok = (argv) => io.run(argv).status === 0;
        const output = (argv) => io.run(argv).stdout.trim();
        state.tools = requiredTools.map((tool) => ({ ...tool, present: tool.commands.some((command) => ok(['sh', '-c', `command -v ${command}`])) }));
        const ownerHome = io.home;
        state.owner = {
            home: ownerHome,
            group: output(['id', '-gn']),
            homeMode: output(['stat', '-c', '%a', ownerHome]),
            acl: io.run(['getfacl', '-cp', ownerHome]).stdout,
        };
        const passwd = io.run(['getent', 'passwd', account]);
        if (![0, 2].includes(passwd.status)) throw new Error(`Could not query Linux account ${account}.`);
        const exists = passwd.status === 0;
        const [, , uid, , , home] = passwd.stdout.trim().split(':');
        const sudoReady = ok(['sudo', '-n', 'true']);
        state.account = {
            exists,
            uid: /^[1-9]\d*$/.test(uid) ? uid : undefined,
            home,
            groups: exists ? output(['id', '-Gn', account]).split(/\s+/).filter(Boolean) : [],
            homeMode: exists ? output(['stat', '-c', '%a', accountHome]) : '',
            sudoAllowed: exists && sudoReady ? parseSudoList(io.run(['sudo', '-n', '-l', '-U', account]).stdout) : false,
        };
        const lingerProbe = sudoReady ? io.run(['sudo', '-n', 'sh', '-c', [
            'set -eu',
            'parent="$2"; dir="$parent/linger"',
            '[ -d "$parent" ] && [ -r "$parent" ] && [ -x "$parent" ] || exit 1',
            'if [ ! -e "$dir" ] && [ ! -L "$dir" ]; then printf "no\\n";',
            'elif [ -d "$dir" ] && [ -r "$dir" ] && [ -x "$dir" ]; then',
            '  if [ -e "$dir/$1" ]; then printf "yes\\n"; else printf "no\\n"; fi;',
            'else exit 1; fi',
        ].join('\n'), 'sh', account, '/var/lib/systemd']) : { status: 1, stdout: '' };
        const lingerValue = lingerProbe.stdout.trim();
        const lingerKnown = lingerProbe.status === 0 && ['yes', 'no'].includes(lingerValue);
        state.lingering = { known: lingerKnown, enabled: lingerKnown && lingerValue === 'yes' };
        state.files = {
            known: !exists || sudoReady,
            error: exists && !sudoReady ? '`sudo -n true` did not succeed' : undefined,
            directories: {}, versionMarker: undefined, configured: false,
        };
        if (exists && sudoReady) {
            const probe = (argv) => io.run(asAccount(argv, { nonInteractive: true }));
            const listing = probe(['sh', '-c', 'set -e; test -x "$HOME"; for p do if [ -d "$p" ]; then stat -c "%a %n" "$p"; fi; done', 'sh', ...accountDirectories]);
            if (listing.status !== 0) {
                state.files.known = false;
                state.files.error = listing.stderr.trim().replace(/\s+/g, ' ').slice(0, 300)
                    || `account directory probe exited with status ${listing.status}`;
            } else {
                for (const line of listing.stdout.split('\n').filter(Boolean)) {
                    const [mode, ...path] = line.split(' ');
                    state.files.directories[path.join(' ')] = mode;
                }
            }
            const read = (path) => { const result = probe(['cat', path]); return result.status === 0 ? result.stdout : undefined; };
            state.files.versionMarker = read(versionMarkerPath) ?? read(legacyVersionMarkerPath);
            state.files.configured = probe(['test', '-f', `${runnerDirectory}/.runner`]).status === 0;
        }
        state.processes = {
            listener: ok(['pgrep', '-u', account, '-f', listenerPattern]),
        };
        return state;
    }

    const systemdRuntimeChecks = [
        '[ -d "$runtime" ] || { echo "Systemd runtime directory $runtime is missing" >&2; exit 1; }',
        '[ "$(stat -c "%u %a" "$runtime")" = "$uid 700" ] || { echo "Unsafe systemd runtime directory $runtime" >&2; exit 1; }',
        '[ -S "$runtime/bus" ] || { echo "Systemd user bus $runtime/bus is missing" >&2; exit 1; }',
    ];

    const runnerStartScript = [
        'set -eu',
        'runtime="$1"; runner="$2"; uid="$3"',
        ...systemdRuntimeChecks,
        'trap \'exit 130\' INT TERM',
        'echo "Runner starting; press Ctrl+C to stop."',
        'cd "$runner"',
        './run.sh',
    ].join('\n');

    function startScriptFor() { return runnerStartScript; }

    function startScriptArguments(uid) { return [runtimeDirectoryFor(uid), runnerDirectory, uid]; }

    function updateRunnerEnv(io) {
        const path = `${runnerDirectory}/.env`;
        const existing = io.run(asAccount(['sh', '-c', 'if [ -e "$1" ] || [ -L "$1" ]; then cat -- "$1"; fi', 'sh', path]));
        if (existing.status !== 0) throw new Error('Could not read the runner .env file.');
        const updated = runnerEnvFile(existing.stdout);
        if (updated === existing.stdout) return;
        const write = [
            'set -eu',
            'tmp=$(mktemp -- "$1.XXXXXX")',
            `trap 'rm -f -- "$tmp"' EXIT`,
            'cat > "$tmp"',
            'mv -fT -- "$tmp" "$1"',
        ].join('\n');
        io.exec(asAccount(['sh', '-c', write, 'sh', path]), { input: updated });
    }

    function createIo() {
        return {
            arch: process.arch,
            platform: process.platform,
            home: userInfo().homedir,
            readText(path) {
                try { return readFileSync(path, 'utf8'); } catch { return undefined; }
            },
            run(argv) {
                const result = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } });
                return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
            },
            fetch(url, options) {
                return fetch(url, options);
            },
            exec(argv, { input } = {}) {
                const result = spawnSync(argv[0], argv.slice(1), input === undefined
                    ? { stdio: 'inherit' }
                    : { input, stdio: ['pipe', 'ignore', 'inherit'] });
                if (result.error) throw result.error;
                if (result.status !== 0) throw new Error(`Command failed (${result.status ?? result.signal}): ${formatCommand(argv)}`);
            },
        };
    }

    function requireTerminal(command) {
        if (!process.stdin.isTTY || !process.stdout.isTTY) {
            throw new Error(`'${command}' asks for confirmations and possibly the sudo password; run \`hedgehog-runner ${command}\` in an interactive terminal.`);
        }
    }

    async function confirm(question) {
        const prompt = createInterface({ input: process.stdin, output: process.stdout });
        try {
            return /^y(es)?$/i.test((await prompt.question(`${question} [y/N] `)).trim());
        } finally {
            prompt.close();
        }
    }

    function authenticateSudo(io) {
        // Lifecycle callers have already required an interactive terminal.
        ensureSudo(io, { interactive: true });
    }

    async function applyChange(change, io) {
        let directory;
        try {
            let archive;
            if (change.download) {
                const response = await io.fetch(runnerUrl);
                if (!response.ok) throw new Error(`Runner download: HTTP ${response.status}`);
                const buffer = Buffer.from(await response.arrayBuffer());
                assertDigest(buffer, runnerDigest);
                directory = await mkdtemp(join(tmpdir(), 'hedgehog-runner-'));
                await chmod(directory, 0o755);
                archive = join(directory, 'actions-runner.tar.gz');
                await writeFile(archive, buffer, { mode: 0o644 });
            }
            for (const step of change.steps) {
                io.exec(step.argv.map((part) => part === archivePlaceholder ? archive : part), { input: step.input });
            }
        } finally {
            if (directory) await rm(directory, { recursive: true, force: true });
        }
    }

    function failOnProblems(problems) {
        if (!problems.length) return;
        throw new Error(`Blocking account/host problems (not changed automatically):\n- ${problems.join('\n- ')}`);
    }

    function requireAccountFilesKnown(state) {
        if (!state.account.exists || state.files.known) return;
        const detail = state.files.error ? ` Inspection detail: ${state.files.error}.` : '';
        throw new Error(`Could not inspect account-owned files for ${account}.${detail} `
            + 'sudo authentication was already checked. If credentials expired, run `sudo -v` in the same terminal and retry. '
            + 'If it persists, inspect the sudo/account-access error; preparation stopped without planning changes from this unknown state.');
    }

    async function continueGuidedSetup(io, options) {
        let owner;
        const steps = [
            {
                name: 'configure-owner',
                run: () => commands['configure-owner'](io, {
                    ...options,
                    onConfigured(selectedOwner) {
                        owner = selectedOwner;
                        options.onConfigured?.(selectedOwner);
                    },
                }),
            },
            { name: 'instructions', run: () => commands.instructions(io, { ...options, owner, interactive: true }) },
            { name: 'status', run: () => commands.status(io) },
        ];
        for (const step of steps.filter(({ name }) => configureOwner || name !== 'configure-owner')) {
            try {
                if (await step.run() !== 0) {
                    console.error(`Setup paused during ${step.name}. Resume manually with \`hedgehog-runner ${step.name}\`.`);
                    return 1;
                }
            } catch (error) {
                console.error(`Setup paused during ${step.name}: ${error instanceof Error ? error.message : String(error)}`);
                console.error(`Resume manually with \`hedgehog-runner ${step.name}\`.`);
                return 1;
            }
        }
        return 0;
    }

    const commands = {
        help: showHelp,
        check(io) {
            const state = inspectHost(io);
            const problems = blockingProblems(state);
            const changes = state.files.known ? planChanges(state) : [];
            console.log(renderCheck(state, changes, problems));
            return problems.length ? 1 : 0;
        },
        async setup(io, options = {}) {
            const { requireTerminal: requireInteractive = requireTerminal, confirmChange = confirm } = options;
            inspectHost(io);
            requireInteractive('setup');
            authenticateSudo(io);
            let state = inspectHost(io);
            failOnProblems(blockingProblems(state));
            requireAccountFilesKnown(state);
            if (!state.lingering.known) throw new Error('Could not verify Lingering; inspect the systemd linger directory and retry.');
            assertMatchingRegistration(io, state);
            if (state.processes.listener) throw new Error('Stop the runner before running setup.');
            const initial = planChanges(state);
            if (!initial.length) {
                console.log('No host changes required.');
                return continueGuidedSetup(io, options);
            }
            console.log(`Planned changes:\n${initial.map((change, index) => renderChange(change, index + 1, initial.length)).join('\n')}\n`);
            const applied = new Set();
            for (let changes = initial; changes.length; changes = planChanges(state)) {
                const [change] = changes;
                if (applied.has(change.id)) throw new Error(`Change '${change.id}' did not take effect; inspect the host manually.`);
                console.log(renderChange(change, applied.size + 1, applied.size + changes.length));
                if (!await confirmChange('Apply this change?')) {
                    console.log('Stopped. Remaining changes were not applied. Resume with `hedgehog-runner setup` when ready.');
                    return 1;
                }
                await applyChange(change, io);
                applied.add(change.id);
                state = inspectHost(io);
                failOnProblems(blockingProblems(state));
                requireAccountFilesKnown(state);
                if (!state.lingering.known) throw new Error('Could not verify Lingering after the change; inspect the systemd linger directory and retry.');
            }
            console.log('Host prepared. Continuing with guided runner setup.');
            return continueGuidedSetup(io, options);
        },
        async instructions(io, options = {}) {
            const {
                interactive = process.stdin.isTTY && process.stdout.isTTY,
                requireTerminal: requireInteractive = requireTerminal,
                confirmRegistration = confirm,
                confirmChange = confirm,
                promptValue: requestValue = promptValue,
                hostName = hostname(),
                owner,
            } = options;
            if (!interactive) {
                console.log(registrationGuide());
                console.log('\nRun `hedgehog-runner instructions` in an interactive terminal to register.');
                return 0;
            }
            requireInteractive('instructions');
            authenticateSudo(io);
            const state = inspectHost(io);
            failOnProblems(blockingProblems(state));
            requireAccountFilesKnown(state);
            assertMatchingRegistration(io, state);
            if (!state.lingering.known) throw new Error('Could not verify Lingering; inspect the systemd linger directory and retry.');
            if (planChanges(state).length) throw new Error('Host is not fully prepared; run `hedgehog-runner setup` first.');
            if (state.files.configured) {
                const registration = runnerRegistration(io);
                console.log(`\nThe runner is already registered as ${registration?.agentName ?? 'an unreadable name'}; it was not changed.`);
                console.log('To update its display name, stop it and run `hedgehog-runner rename`.');
                return 0;
            }
            const selectedOwner = localRunnerName ? undefined : await resolveRunnerOwner(io, { owner, confirmChange, promptValue: requestValue });
            const name = localRunnerName ?? runnerName(hostName, selectedOwner.login);
            console.log(registrationGuide(name));
            const accountLabel = selectedOwner ? ` for verified GitHub account @${selectedOwner.login} (ID ${selectedOwner.id})` : '';
            console.log(`\nRegister as ${name}${accountLabel}.`);
            if (!await confirmRegistration('\nRegister the runner now (config.sh will ask for the token)?')) return 1;
            io.exec(registrationCommand(name));
            console.log('Registered. The guided setup will now show the runner status. Start it later with `hedgehog-runner start` in a dedicated terminal.');
            return 0;
        },
        async ['configure-owner'](io, {
            requireTerminal: requireInteractive = requireTerminal,
            confirmChange = confirm,
            promptValue: requestValue = promptValue,
            onConfigured = () => {},
        } = {}) {
            if (!configureOwner) throw new Error('Enable configureOwner in .hedgehog.json to configure RUNNER_OWNER_ID.');
            requireInteractive('configure-owner');
            const cliInstalled = io.run(['gh', '--version']).status === 0;
            let cliAuthenticated = false;
            let authenticatedUser;
            if (!cliInstalled) {
                console.log('GitHub CLI (gh) is not installed. It is optional: install it and authenticate with `gh auth login` to set the variable automatically, or continue with the public lookup and manual GitHub settings.');
            } else if (io.run(['gh', 'auth', 'status']).status !== 0) {
                console.log('GitHub CLI is not authenticated. It is optional: run `gh auth login` to set the variable automatically, or continue with the public lookup and manual GitHub settings.');
            } else {
                cliAuthenticated = true;
                try {
                    authenticatedUser = queryGitHubUser(io, 'user', 'identify the GitHub CLI account');
                } catch {
                    console.log('Could not read the authenticated GitHub account; enter a username for public lookup instead.');
                }
            }

            let selectedUser;
            if (authenticatedUser && await confirmChange(`Use authenticated GitHub account @${authenticatedUser.login} (ID ${authenticatedUser.id}) as the PR owner?`)) {
                selectedUser = authenticatedUser;
            } else {
                const login = (await requestValue('GitHub username to associate with this laptop: ')).trim();
                if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(login)) {
                    throw new Error('Enter a valid GitHub username; no repository setting was changed.');
                }
                selectedUser = await queryPublicGitHubUser(io, `users/${encodeURIComponent(login)}`, `resolve GitHub username @${login}`);
            }

            const action = cliAuthenticated
                ? `set repository Actions variable ${ownerVariableName} to @${selectedUser.login} (ID ${selectedUser.id})`
                : `use @${selectedUser.login} (ID ${selectedUser.id}) and then set ${ownerVariableName} manually in GitHub`;
            if (!await confirmChange(`Confirm ${action}?`)) {
                console.log('Stopped. No repository setting was changed.');
                return 1;
            }

            if (!cliAuthenticated) {
                console.log(`No repository setting was changed by this command.\n${manualOwnerVariableSteps(selectedUser)}`);
                if (!await confirmChange(`Have you set ${ownerVariableName} to ${selectedUser.id} in GitHub?`)) {
                    console.log(`Setup stopped. Set the variable, then run \`hedgehog-runner configure-owner\` again to continue.`);
                    return 1;
                }
                onConfigured(selectedUser);
                return 0;
            }

            try {
                io.exec(ownerVariableCommand(selectedUser.id));
            } catch (error) {
                throw new Error(`Could not set ${ownerVariableName}; the write did not report success. Verify the variable in GitHub. `
                    + `${manualOwnerVariableSteps(selectedUser)} ${error instanceof Error ? error.message : String(error)}`);
            }
            console.log(`Configured ${ownerVariableName} for @${selectedUser.login}. The ID is stored as a repository Actions variable, not in this checkout.`);
            onConfigured(selectedUser);
            return 0;
        },
        async rename(io, options = {}) {
            const {
                requireTerminal: requireInteractive = requireTerminal,
                confirmChange = confirm,
                promptValue: requestValue = promptValue,
                hostName = hostname(),
            } = options;
            requireInteractive('rename');
            authenticateSudo(io);
            const state = inspectHost(io);
            failOnProblems(blockingProblems(state));
            requireAccountFilesKnown(state);
            if (state.processes.listener) {
                throw new Error('Stop the runner first with `hedgehog-runner stop`; renaming never interrupts a running process.');
            }
            if (!state.files.configured) throw new Error('The runner is not registered; use `hedgehog-runner instructions` instead.');
            const currentRegistration = runnerRegistration(io);
            if (!currentRegistration?.agentName) throw new Error('Could not read the current runner name from `.runner`; no change was made.');
            assertMatchingRegistration(io, state);
            const newName = localRunnerName ?? runnerName(hostName, (await resolveRunnerOwner(io, { confirmChange, promptValue: requestValue })).login);
            if (currentRegistration.agentName === newName) {
                console.log(`The runner is already named ${newName}; no change was made.`);
                return 0;
            }
            console.log(`Current GitHub runner name: ${currentRegistration.agentName}\nNew name: ${newName}`);
            if (!await confirmChange('Deregister and register this runner again with the new name? config.sh will request short-lived tokens.')) {
                console.log('Renaming cancelled; the existing registration and runner data were not changed.');
                return 1;
            }
            try {
                io.exec(removalCommand());
            } catch (error) {
                throw new Error(`Could not complete the old runner removal. Check GitHub and local registration status before retrying. `
                    + `${error instanceof Error ? error.message : String(error)}`);
            }
            try {
                io.exec(registrationCommand(newName));
            } catch (error) {
                throw new Error(`The old registration was removed, but registration as ${newName} did not complete. Runner data and caches were kept. `
                    + `Retry with \`hedgehog-runner instructions\`. ${error instanceof Error ? error.message : String(error)}`);
            }
            console.log(`Runner renamed to ${newName}. The service account, workspace and caches were kept.`);
            return 0;
        },
        async status(io) {
            const state = inspectHost(io);
            const lines = [
                `account ${account}: ${state.account.exists ? `present (groups: ${state.account.groups.join(' ')})` : 'missing'}`,
                `runner process: ${state.processes.listener ? 'running' : 'stopped'}`,
                ...(configureOwner ? [await renderOwnerStatus(io)] : []),
            ];
            if (state.account.exists && state.files.known) {
                const registrationInfo = runnerRegistration(io);
                let registration = 'not registered';
                if (registrationInfo) registration = registrationInfo.agentName
                    ? `${registrationInfo.agentName} → ${registrationInfo.gitHubUrl}`
                    : 'registered (unreadable .runner)';
                lines.push(`registration: ${registration}`, `installed runner: ${state.files.versionMarker?.split(' ')[0] ?? 'none'} (pinned ${runnerVersion})`);
                const sizes = io.run(asAccount(['sh', '-c', 'du -sh "$@" 2>/dev/null || true', 'sh', `${accountHome}/.cache`,
                    `${runnerDirectory}/_work`], { nonInteractive: true })).stdout.trim();
                lines.push('cache sizes:', ...(sizes ? sizes.split('\n').map((line) => `  ${line}`) : ['  none']));
            } else if (state.account.exists) {
                lines.push('registration and caches: run `sudo -v` first to include them (read-only)');
            }
            console.log(lines.join('\n'));
            return 0;
        },
        async start(io) {
            let state = inspectHost(io);
            if (state.processes.listener) {
                throw new Error('The runner is already running; use `hedgehog-runner stop` first.');
            }
            requireTerminal('start');
            authenticateSudo(io);
            state = inspectHost(io);
            failOnProblems(blockingProblems(state));
            if (!state.lingering.known) throw new Error('Could not verify Lingering; inspect the systemd linger directory and retry.');
            if (planChanges(state).length) throw new Error('Host is not fully prepared; run `hedgehog-runner setup` first.');
            requireAccountFilesKnown(state);
            if (!state.files.configured) throw new Error('The runner is not registered; run `hedgehog-runner instructions` first.');
            const systemd = assertSystemdUserManager(io);
            assertMatchingRegistration(io, state);
            updateRunnerEnv(io);
            const onInterrupt = () => { /* The foreground runner handles Ctrl+C. */ };
            process.on('SIGINT', onInterrupt);
            let result;
            try {
                const [sudo, ...args] = asAccount([
                    'sh', '-c', startScriptFor(), 'sh', ...startScriptArguments(systemd.uid),
                ], { environment: systemd.environment });
                result = spawnSync(sudo, args, { stdio: 'inherit' });
            } finally {
                process.off('SIGINT', onInterrupt);
            }
            console.log('Runner stopped.');
            return result.status === 130 || result.signal === 'SIGINT' ? 0 : result.status ?? 1;
        },
        async stop(io) {
            let state = inspectHost(io);
            if (!state.processes.listener) {
                console.log('The runner is not running.');
                return 0;
            }
            requireTerminal('stop');
            authenticateSudo(io);
            state = inspectHost(io);
            requireAccountFilesKnown(state);
            failOnProblems(blockingProblems(state));
            assertMatchingRegistration(io, state);
            io.run(asAccount(['pkill', '-INT', '-f', listenerPattern]));
            for (let i = 0; i < 60 && io.run(['pgrep', '-u', account, '-f', listenerPattern]).status === 0; i++) {
                spawnSync('sleep', ['0.5']);
            }
            if (io.run(['pgrep', '-u', account, '-f', listenerPattern]).status === 0) {
                throw new Error('The runner did not stop; check its foreground terminal.');
            }
            console.log('Stopped the runner; caches were kept.');
            return 0;
        },
        async remove(io, { requireTerminal: requireInteractive = requireTerminal, confirmChange = confirm } = {}) {
            requireInteractive('remove');
            authenticateSudo(io);
            const state = inspectHost(io);
            if (!state.account.exists) {
                throw new Error(`Cannot remove runner for ${repository}: Linux account ${account} does not exist. `
                    + `Expected directory: ${runnerDirectory}. Check the repository, local profile or --account selection.`);
            }
            if (state.processes.listener) {
                throw new Error('The runner is running; stop it first (Ctrl+C or `hedgehog-runner stop`).');
            }
            requireAccountFilesKnown(state);
            failOnProblems(blockingProblems(state));
            assertMatchingRegistration(io, state);
            const registration = state.files.configured ? runnerRegistration(io) : undefined;
            console.log(`Removal target:\nRepository: ${repositoryUrl}\nRunner: ${registration?.agentName ?? '(not registered)'}\n`
                + `Linux account: ${account}\nDirectory: ${runnerDirectory}`);
            let deregistered = !state.files.configured;
            if (state.files.configured) {
                console.log(`Open ${runnersSettingsUrl}, select the runner, choose "Remove" and copy the removal token. config.sh will ask for it.`);
                if (await confirmChange('Deregister the runner from GitHub now?')) {
                    try { io.exec(removalCommand()); deregistered = true; } catch (error) { console.error(error.message); }
                }
            }
            if (!deregistered) {
                console.log(removalFollowUps({ deregistered, accountRemoved: false }).join('\n'));
                return 1;
            }
            let accountRemoved = !state.account.exists;
            if (state.account.exists) {
                const remove = runnerDirectoryRemovalCommand();
                console.log(`$ ${formatCommand(remove)}`);
                if (await confirmChange('Delete the runner directory? The systemd-managed runtime directory will not be deleted.')) io.exec(remove);
                const userdel = ['sudo', 'userdel', '--remove', account];
                console.log(`$ ${formatCommand(userdel)}  (also deletes the workspace and caches of ${account})`);
                if (await confirmChange(`Delete account ${account} and its home directory?`)) {
                    if (!await confirmChange(`Disable systemd lingering for ${account} before deleting the account?`)) {
                        throw new Error('Account deletion stopped; disable lingering manually before removing the account.');
                    }
                    io.exec(['sudo', 'loginctl', 'disable-linger', account]);
                    console.log(`Stopping remaining processes owned by ${account} before deleting the account.`);
                    if (!terminateAccountProcesses(io)) {
                        throw new Error(`Processes owned by ${account} remain. Inspect them with `
                            + `\`sudo pgrep -a -u ${account}\` and stop them before retrying removal.`);
                    }
                    io.exec(userdel);
                    accountRemoved = true;
                }
            }
            console.log(`Remaining manual steps:\n- ${removalFollowUps({ deregistered, accountRemoved }).join('\n- ')}`);
            return 0;
        },
    };

    async function main(argv = process.argv.slice(2), io = createIo(), options = {}) {
        if (argv.some((argument) => ['help', '--help', '-h'].includes(argument))) return commands.help();
        const [name] = argv.filter((argument) => argument !== '--');
        const command = Object.hasOwn(commands, name) ? commands[name] : undefined;
        if (!command) {
            console.error(`Unknown command${name ? `: ${name}` : ''}. Run \`hedgehog-runner help\` for available commands.`);
            return 1;
        }
        try {
            return await command(io, options);
        } catch (error) {
            console.error(error instanceof Error ? error.message : String(error));
            if (name === 'setup') console.error('Resume with `hedgehog-runner setup` after resolving the issue.');
            return 1;
        }
    }

    return {
        account, accountDirectories, accountHome, asAccount, assertDigest, assertSupportedPlatform, assertSystemdUserManager,
        blockingProblems, getAccountUid, inspectHost, main, parseOsRelease, planChanges, parseGitHubUser, registrationCommand, registrationGuide,
        removalCommand, removalFollowUps, runnerDirectory, runnerDirectoryRemovalCommand, runnerEnvFile, runnerLabel, runnerName,
        runtimeDirectoryFor, startScriptArguments, startScriptFor, systemdUserEnvironment, terminateAccountProcesses,
        versionMarker, versionMarkerPath, ownerVariableCommand, ownerVariableName,
    };
}

/** sudo owns password input; the CLI never reads or stores it. Returns whether authentication was refreshed. */
export function ensureSudo(io, { interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY), log = console.log } = {}) {
    if (io.run(['sudo', '-n', '-v']).status === 0) return false;
    if (!interactive) {
        throw new Error('sudo authentication is required, but no interactive terminal is available. '
            + 'Run this command in a terminal (for example WebStorm Terminal, Alt+F12). '
            + 'You can also run sudo -v in the same terminal before retrying.');
    }
    log('sudo authentication is needed to access the dedicated runner accounts. Enter your password at the sudo prompt.');
    try { io.exec(['sudo', '-v']); }
    catch {
        throw new Error('sudo authentication failed or was cancelled. Check the sudo message above and your sudo permissions, then retry.');
    }
    return true;
}

export function listInstalledRunners(io = {
    run(argv) {
        const result = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? result.error?.message ?? '' };
    },
    exec(argv) {
        const result = spawnSync(argv[0], argv.slice(1), { stdio: 'inherit' });
        if (result.error || result.status !== 0) throw new Error('sudo failed');
    },
}, options = {}) {
    const accounts = io.run(['getent', 'passwd']);
    if (accounts.status !== 0) throw new Error('Could not enumerate Linux accounts with getent passwd.');
    const groups = new Map();
    const unverified = [];
    const unregistered = [];
    let authenticationChecked = false;
    let authenticationError;
    const safeText = (value) => value.replace(/[\u0000-\u001f\u007f-\u009f]/g, '?');
    for (const line of accounts.stdout.split('\n').filter(Boolean)) {
        const [account, , uid, , , home] = line.split(':');
        if (!/^gha-[a-z\d][a-z\d-]{0,26}$/.test(account)) continue;
        const directory = `/home/${account}/actions-runner`;
        if (!/^[1-9]\d*$/.test(uid) || home !== `/home/${account}`) {
            unverified.push(`${account}: unexpected UID or home directory`);
            continue;
        }
        const runner = createRunner({ account, repository: 'inventory/placeholder', labels: [], jobEnv: {} });
        const probeCommand = runner.asAccount(['sh', '-c', [
            'test -x "$HOME" || exit 4',
            'if [ ! -e "$1" ]; then exit 3; fi',
            'test -d "$1" && test -r "$1" && test -x "$1" || exit 4',
            'if [ -e "$1/.runner" ]; then cat "$1/.runner"; else exit 2; fi',
        ].join('\n'), 'sh', directory], { nonInteractive: true });
        let probe = io.run(probeCommand);
        if (![0, 2, 3].includes(probe.status) && !authenticationChecked) {
            authenticationChecked = true;
            try {
                if (ensureSudo(io, options)) probe = io.run(probeCommand);
            } catch (error) { authenticationError = error.message; }
        }
        if (probe.status === 3) continue;
        if (probe.status === 2) {
            unregistered.push(`${account} — ${directory}`);
            continue;
        }
        if (probe.status !== 0) {
            const detail = probe.stderr?.trim() || `account probe exited with status ${probe.status ?? 'unknown'}`;
            unverified.push(`${account}: could not inspect ${directory} as the dedicated account: ${safeText(detail).slice(0, 300)}`);
            continue;
        }
        try {
            const { agentName, gitHubUrl } = JSON.parse(probe.stdout.replace(/^\uFEFF/, ''));
            const match = typeof gitHubUrl === 'string' && /^https:\/\/github\.com\/([a-z\d][a-z\d-]*\/[a-z\d_.-]+)\/?$/i.exec(gitHubUrl);
            if (!match || ['.', '..'].includes(match[1].split('/')[1]) || typeof agentName !== 'string' || !agentName) throw new Error();
            const repository = match[1].toLowerCase();
            if (!groups.has(repository)) groups.set(repository, []);
            groups.get(repository).push(`${safeText(agentName)} — ${account} — ${directory}`);
        } catch {
            unverified.push(`${account}: invalid registration metadata in ${directory}/.runner`);
        }
    }
    const lines = [];
    for (const repository of [...groups.keys()].sort()) {
        lines.push(`${repository}:`, ...groups.get(repository).sort().map((entry) => `  ${entry}`));
    }
    if (unregistered.length) lines.push('Unregistered installations:', ...unregistered.sort().map((entry) => `  ${entry}`));
    if (unverified.length) lines.push('Unverified accounts (inventory incomplete):', ...unverified.sort().map((entry) => `  ${entry}`),
        'For invalid metadata or unexpected account settings, inspect the reported account.');
    if (authenticationError) lines.push(authenticationError);
    if (!lines.length) lines.push('No installed Hedgehog runners found.');
    return { output: lines.join('\n'), code: unverified.length ? 1 : 0 };
}

function showHelp() {
    console.log(`Hedgehog Runner

Usage: hedgehog-runner <command> [options]

  check            Inspect the host and show pending setup changes.
  setup            Confirm setup changes and guide registration.
  instructions     Show registration steps and offer to register interactively.
  configure-owner  Select whose PRs a compatible workflow should prefer locally.
                   Set their numeric GitHub ID as repository RUNNER_OWNER_ID.
  rename           Confirm deregistration and re-registration under a new name.
  status           Show local registration, process and optional owner status.
  list             List local installations grouped by repository (read-only).
  start            Start the runner in the foreground. Ctrl+C stops it.
  stop             Stop the runner and keep the workspace and caches.
  remove           Confirm deregistration or removal of the runner and account.

Options (before or after the command):
  --config <file>          Use this JSON file instead of checkout .hedgehog.json.
  --repository <org/repo>  Select the GitHub repository.
  --label <label>          Custom label; repeat for several. Replaces file labels.
  --configure-owner       Enable the optional PR-owner configuration step.
  --no-configure-owner    Disable that step.
  --job-env <NAME=VALUE>   Repeat for several. Replaces the file jobEnv map.
  --account <gha-user>    Override the local dedicated Linux account.
  --runner-name <name>    Override the local display name (not runner identity).

Precedence: CLI options > project file / local profile > defaults.
Only setup prompts for missing repository and labels in an interactive terminal.
Setup offers to save supplied values after showing the files to be written.
Other commands require a repository; setup, instructions and rename need labels.
Remove --repository works without a checkout or file; no labels/name are needed.
List needs no configuration and accepts no configuration options.
List inspects gha-* accounts under /home/<account>/actions-runner.
List, setup and remove request sudo authentication in a terminal when needed.
Without a terminal, list reports unreadable accounts; partial results exit 1.

PR-owner configuration (optional):
  Select a GitHub account whose PRs should prefer your local runner, for example
  to run your own E2E tests on your laptop while other PRs use hosted runners.
  Requires configureOwner: true or --configure-owner; setup includes the step.
  It can also run independently, without a local runner or registration.
  Authenticated gh can set RUNNER_OWNER_ID after confirmation; otherwise the CLI
  verifies a username publicly and guides manual setup in GitHub settings.
  Your workflow must read vars.RUNNER_OWNER_ID and implement runner selection.
  For example: same-repository owner PR + online, idle matching runner => local;
  otherwise => ubuntu-latest. This fallback requires a workflow selector.
  The variable is repository-wide. It does not enforce runner access or rename
  existing runners. This command does not create or edit workflows.

Tokens are entered only in GitHub's config.sh, never as CLI options.
Use --help, -h or help to show this message.`);
    return 0;
}

async function configurationPrompt(question) {
    const terminal = createInterface({ input: process.stdin, output: process.stdout });
    try { return await terminal.question(question); }
    finally { terminal.close(); }
}

export async function runCli(args = process.argv.slice(2), {
    configOptions, runnerFactory = createRunner, listIo,
    interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY),
    prompt = configurationPrompt,
    confirm = async (question) => /^y(es)?$/i.test((await configurationPrompt(`${question} [y/N] `)).trim()),
} = {}) {
    if (!args.length || args.some((arg) => ['help', '--help', '-h'].includes(arg))) return showHelp();
    try {
        const { values, positionals, tokens } = parseArgs({ args, allowPositionals: true, tokens: true, options: {
            config: { type: 'string' }, repository: { type: 'string' }, account: { type: 'string' },
            'runner-name': { type: 'string' }, label: { type: 'string', multiple: true },
            'job-env': { type: 'string', multiple: true },
            'configure-owner': { type: 'boolean' }, 'no-configure-owner': { type: 'boolean' },
        } });
        const seen = new Set();
        for (const token of tokens.filter(({ kind }) => kind === 'option')) {
            if (seen.has(token.name) && !['label', 'job-env'].includes(token.name)) throw new Error(`Pass --${token.name} only once.`);
            seen.add(token.name);
            if (typeof token.value === 'string' && (!token.value || token.value.startsWith('-'))) throw new Error(`--${token.name} requires a value.`);
        }
        if (positionals.length !== 1) throw new Error('Pass exactly one command. See hedgehog-runner --help.');
        const [command] = positionals;
        if (!['check', 'setup', 'instructions', 'configure-owner', 'rename', 'status', 'list', 'start', 'stop', 'remove'].includes(command)) {
            throw new Error(`Unknown command: ${command}. See hedgehog-runner --help.`);
        }
        if (command === 'list') {
            if (seen.size) throw new Error('list accepts no configuration options; it lists all local installations.');
            const result = listInstalledRunners(listIo, { interactive });
            console.log(result.output);
            return result.code;
        }
        if (values['configure-owner'] && values['no-configure-owner']) throw new Error('Choose either --configure-owner or --no-configure-owner.');
        const overrides = {};
        for (const [option, field] of [['repository', 'repository'], ['account', 'account'], ['runner-name', 'runnerName'], ['label', 'labels']]) {
            if (values[option] !== undefined) overrides[field] = values[option];
        }
        if (values['configure-owner'] !== undefined || values['no-configure-owner'] !== undefined) overrides.configureOwner = Boolean(values['configure-owner']);
        if (values['job-env']) {
            overrides.jobEnv = {};
            for (const entry of values['job-env']) {
                const separator = entry.indexOf('=');
                if (separator < 1) throw new Error('--job-env requires NAME=VALUE.');
                const key = entry.slice(0, separator);
                if (Object.hasOwn(overrides.jobEnv, key)) throw new Error(`Duplicate --job-env key: ${key}.`);
                Object.defineProperty(overrides.jobEnv, key, { value: entry.slice(separator + 1), enumerable: true });
            }
        }
        const config = await loadConfig(values.config, overrides, { ...configOptions, command, interactive, prompt, confirm });
        return await runnerFactory(config).main([command]);
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        return 1;
    }
}
