import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

const reservedEnvironment = new Set([
    'HOME', 'USER', 'LOGNAME', 'SHELL', 'PATH', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS',
    'BASH_ENV', 'ENV', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'NODE_OPTIONS',
]);

function validateFields(value, allowed, source) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`${source} must contain a JSON object.`);
    }
    for (const key of Object.keys(value)) {
        if (!allowed.includes(key)) throw new Error(`Unknown field "${key}" in ${source}.`);
    }
}

function validRepository(value) {
    return typeof value === 'string' && /^[a-z\d][a-z\d-]*\/[a-z\d_.-]+$/i.test(value) &&
        !['.', '..'].includes(value.split('/')[1]);
}

export function validateConfig(project, local = {}, { requireLabels = true } = {}) {
    validateFields(project, ['version', 'repository', 'labels', 'configureOwner', 'jobEnv'], '.hedgehog.json');
    validateFields(local, ['account', 'runnerName'], 'the local profile');
    const { version, repository, labels, configureOwner = false, jobEnv = {} } = project;
    if (version !== 1) throw new Error('.hedgehog.json must specify version 1.');
    if (!validRepository(repository)) throw new Error('repository must be a GitHub owner/repository slug.');
    if (!Array.isArray(labels) || (requireLabels && !labels.length) || labels.some((label) =>
        typeof label !== 'string' || !/^[a-z\d][a-z\d_.-]{0,62}$/i.test(label) ||
        ['self-hosted', 'linux', 'x64'].includes(label.toLowerCase()))) {
        throw new Error('labels must contain at least one custom runner label of up to 63 characters.');
    }
    if (new Set(labels.map((label) => label.toLowerCase())).size !== labels.length) {
        throw new Error('labels must be unique.');
    }
    if (typeof configureOwner !== 'boolean') throw new Error('configureOwner must be a boolean.');
    if (jobEnv === null || typeof jobEnv !== 'object' || Array.isArray(jobEnv)) {
        throw new Error('jobEnv must be an object mapping names to strings.');
    }
    for (const [key, value] of Object.entries(jobEnv)) {
        if (!/^[a-z_][a-z\d_]*$/i.test(key) || reservedEnvironment.has(key) ||
            /^(?:GITHUB|RUNNER|ACTIONS)_/.test(key)) {
            throw new Error(`Unsupported jobEnv variable "${key}".`);
        }
        if (typeof value !== 'string' || /[\u0000\r\n]/.test(value)) {
            throw new Error(`jobEnv variable "${key}" must be a single-line string.`);
        }
    }

    const defaultAccount = `gha-${createHash('sha256').update(repository.toLowerCase()).digest('hex').slice(0, 12)}`;
    const { account = defaultAccount, runnerName } = local;
    if (typeof account !== 'string' || !/^gha-[a-z\d][a-z\d-]{0,26}$/.test(account)) {
        throw new Error('The local profile account must be a dedicated Linux username starting with gha-.');
    }
    if (runnerName !== undefined && (typeof runnerName !== 'string' ||
        !/^[a-z\d][a-z\d_.-]{0,62}$/i.test(runnerName))) {
        throw new Error('The local profile runnerName must contain 1–63 letters, digits, dots, underscores or hyphens.');
    }

    return { repository, labels, configureOwner, jobEnv, account, runnerName };
}

function readJson(path, optional = false) {
    let content;
    try {
        content = readFileSync(path, 'utf8');
    } catch (error) {
        if (optional && error.code === 'ENOENT') return {};
        throw new Error(`Could not read ${path} (${error.code ?? 'unknown error'}).`);
    }
    try {
        return JSON.parse(content);
    } catch {
        throw new Error(`Invalid JSON in ${path}.`);
    }
}

/** Resolve once, validate every source, and persist only after showing and confirming writes. */
export async function loadConfig(path, overrides = {}, {
    command, cwd = process.cwd(), user = userInfo(), configHome = process.env.XDG_CONFIG_HOME,
    interactive = false, prompt, confirm, log = console.log,
} = {}) {
    if (user.uid === 0) throw new Error('Run Hedgehog Runner as your own user; it prompts for sudo where needed.');
    const git = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' });
    const root = git.status === 0 && git.stdout.trim() ? git.stdout.trimEnd() : cwd;
    const projectPath = path ? resolve(cwd, path) : join(root, '.hedgehog.json');
    // Explicit removal targets remain independent of a checkout's configuration.
    const skipDiscovery = command === 'remove' && overrides.repository !== undefined && !path;
    const exists = !skipDiscovery && existsSync(projectPath);
    const source = skipDiscovery ? {} : readJson(projectPath, !path);
    validateFields(source, ['version', 'repository', 'labels', 'configureOwner', 'jobEnv'], projectPath);
    const placeholder = { version: 1, repository: 'validation/placeholder', labels: ['validation'] };
    validateConfig({ ...placeholder, ...source });
    const { account, runnerName, ...projectOverrides } = overrides;
    const localOverrides = { ...(account === undefined ? {} : { account }), ...(runnerName === undefined ? {} : { runnerName }) };
    validateConfig({ ...placeholder, ...projectOverrides }, localOverrides);
    const project = { version: 1, configureOwner: false, jobEnv: {}, ...source, ...projectOverrides };
    const requireLabels = ['setup', 'instructions', 'rename', 'workflow'].includes(command);
    let prompted = false;
    for (const [key, question, option] of [
        ['repository', 'GitHub repository (owner/repo): ', '--repository owner/repo'],
        ...(requireLabels ? [['labels', 'Custom runner labels (comma-separated): ', '--label laptop']] : []),
    ]) {
        if (project[key] !== undefined) continue;
        if (command !== 'setup' || !interactive) {
            throw new Error(`Missing ${key}. Set it in ${projectPath} or pass ${option}. `
                + 'Run setup in an interactive terminal to enter missing setup values.');
        }
        while (true) {
            const answer = (await prompt(question)).trim();
            if (!answer) throw new Error(`Missing ${key}; setup cancelled before host changes.`);
            const value = key === 'labels' ? answer.split(',').map((label) => label.trim()) : answer;
            try { validateConfig({ ...placeholder, [key]: value }); }
            catch (error) { log(error.message); continue; }
            project[key] = value;
            prompted = true;
            break;
        }
    }
    project.labels ??= [];
    const settings = configHome && isAbsolute(configHome) ? configHome : join(user.homedir, '.config');
    const profilePath = join(settings, 'hedgehog-runner', `${project.repository.toLowerCase()}.json`);
    const local = readJson(profilePath, true);
    validateConfig(project, local, { requireLabels });
    const profile = { ...local, ...localOverrides };
    const config = validateConfig(project, profile, { requireLabels });
    if (config.account === user.username) throw new Error('The runner account must be separate from your own account.');
    if (command === 'setup') {
        log(`Configuration:\nRepository: ${config.repository}\nLinux account: ${config.account}\n`
            + `Runner name: ${config.runnerName ?? '(derived during registration)'}\nLabels: ${config.labels.join(', ')}\n`
            + `Configure owner: ${config.configureOwner}\nJob environment keys: ${Object.keys(config.jobEnv).join(', ') || '(none)'}`);
        if (interactive && (prompted || Object.keys(overrides).length)) {
            const files = [[projectPath, project], ...(Object.keys(localOverrides).length ? [[profilePath, profile]] : [])];
            for (const [file, value] of files) log(`Save configuration to ${file}:\n${JSON.stringify(value, null, 2)}`);
            if (await confirm('Save this configuration for subsequent commands?')) {
                for (const [file, value] of files) {
                    if (file === profilePath) mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
                    writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: existsSync(file) ? 'w' : 'wx' });
                }
            } else if (prompted || !exists) {
                log('Configuration was not saved. Pass the same options again for subsequent commands.');
            }
        }
    }
    return config;
}
