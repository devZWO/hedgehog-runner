import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

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

export function validateConfig(project, local = {}) {
    validateFields(project, ['version', 'repository', 'labels', 'configureOwner', 'jobEnv'], '.runnerconfig');
    validateFields(local, ['account', 'runnerName'], 'the local profile');
    const { version, repository, labels, configureOwner = false, jobEnv = {} } = project;
    if (version !== 1) throw new Error('.runnerconfig must specify version 1.');
    if (!validRepository(repository)) throw new Error('repository must be a GitHub owner/repository slug.');
    if (!Array.isArray(labels) || !labels.length || labels.some((label) =>
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

export function loadConfig(path, { cwd = process.cwd(), user = userInfo(), configHome = process.env.XDG_CONFIG_HOME } = {}) {
    let projectPath;
    if (path) {
        projectPath = resolve(cwd, path);
    } else {
        const git = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' });
        if (git.status !== 0 || !git.stdout.trim()) {
            throw new Error('Run from a Git checkout with a .runnerconfig or pass --config <file>.');
        }
        projectPath = join(git.stdout.trimEnd(), '.runnerconfig');
    }

    if (user.uid === 0) throw new Error('Run Hedgehog Runner as your own user; it prompts for sudo where needed.');
    const project = readJson(projectPath);
    if (!validRepository(project?.repository)) throw new Error(`Invalid repository in ${projectPath}.`);
    const settings = configHome && isAbsolute(configHome) ? configHome : join(user.homedir, '.config');
    const profilePath = join(settings, 'hedgehog-runner', `${project.repository.toLowerCase()}.json`);
    const config = validateConfig(project, readJson(profilePath, true));
    if (config.account === user.username) throw new Error('The runner account must be separate from your own account.');
    return config;
}
