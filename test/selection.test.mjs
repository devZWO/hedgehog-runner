import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parseDocument } from 'yaml';
import { selectionRequest, selectRunner } from '../src/selection.mjs';
import { selectionWorkflow } from '../scripts/selection-workflow.mjs';

const labels = ['self-hosted', 'linux', 'x64', 'laptop'];
const input = { eventName: 'pull_request', repository: 'example/project', authorId: 123,
    headRepository: 'example/project', ownerId: '123', labels: JSON.stringify(labels) };
const runner = { status: 'online', busy: false, labels: labels.map((name) => ({ name })) };

test('only same-repository owner PRs with valid labels and owner configuration are eligible', async () => {
    assert.equal(selectionRequest(input).eligible, true);
    for (const changes of [
        { eventName: 'push' }, { eventName: 'pull_request_target' }, { eventName: 'workflow_dispatch' },
        { headRepository: 'someone/fork' }, { headRepository: undefined },
        { authorId: 456 }, { authorId: undefined }, { ownerId: '' }, { ownerId: 'invalid' },
        { ownerId: '0' }, { ownerId: '9007199254740992' },
        { labels: '{' }, { labels: 'null' }, { labels: [] }, { labels: ['laptop'] },
        { labels: ['self-hosted', 'Laptop', 'laptop'] }, { labels: ['self-hosted', 'bad\nlabel'] },
        { fallback: 'self-hosted' },
    ]) {
        const request = selectionRequest({ ...input, ...changes });
        assert.equal(request.eligible, false, JSON.stringify(changes));
        const result = await selectRunner(request, { credentialsAvailable: true,
            listRunners: () => assert.fail('Ineligible requests must never query runner availability') });
        assert.equal(result.runsOn, 'ubuntu-latest');
        assert.ok(result.reason);
    }
});

test('availability requires online, idle and every label; matching is case insensitive', async () => {
    const request = selectionRequest(input);
    for (const runners of [[], [{ ...runner, status: 'offline' }], [{ ...runner, busy: true }],
        [{ ...runner, busy: undefined }], [{ ...runner, labels: [{ name: 'laptop' }] }],
        [null, {}, { ...runner, labels: [null] }], null]) {
        const result = await selectRunner(request, { credentialsAvailable: true, listRunners: async () => runners });
        assert.equal(result.runsOn, 'ubuntu-latest');
    }
    const result = await selectRunner(request, { credentialsAvailable: true, listRunners: async () => [
        { ...runner, busy: true }, { ...runner, labels: labels.map((name) => ({ name: name.toUpperCase() })) },
    ] });
    assert.deepEqual(result.runsOn, labels);
});

test('missing credentials and API failures select a configurable hosted fallback without exposing errors', async () => {
    const request = selectionRequest({ ...input, fallback: 'ubuntu-24.04' });
    const missing = await selectRunner(request, { credentialsAvailable: false,
        listRunners: () => assert.fail('Missing credentials must not trigger API calls') });
    assert.equal(missing.runsOn, 'ubuntu-24.04');
    const failed = await selectRunner(request, { credentialsAvailable: true,
        listRunners: async () => { throw new Error('private request details'); } });
    assert.equal(failed.runsOn, 'ubuntu-24.04');
    assert.doesNotMatch(JSON.stringify(failed), /private request details/);
});

const workflowPath = new URL('../.github/workflows/select-runner.yml', import.meta.url);
function workflow() {
    const document = parseDocument(readFileSync(workflowPath, 'utf8'), { uniqueKeys: true });
    assert.deepEqual(document.errors, []);
    return document.toJS();
}

test('workflow embeds current tested source, pins dependencies, scopes secrets and never checks out caller code', () => {
    assert.equal(readFileSync(workflowPath, 'utf8'), selectionWorkflow());
    const value = workflow();
    assert.ok(value.on.workflow_call);
    assert.deepEqual(value.permissions, { contents: 'read' });
    const job = value.jobs.select;
    assert.equal(job['runs-on'], 'ubuntu-latest');
    assert.equal(job['timeout-minutes'], 5);
    assert.equal(job.steps.length, 3);
    for (const step of job.steps) assert.match(step.uses, /^actions\/[a-z-]+@[a-f\d]{40}$/);
    const tokenStep = job.steps[1];
    assert.match(tokenStep.if, /eligible == 'true'.*app-configured == 'true'/);
    assert.equal(tokenStep['continue-on-error'], true);
    assert.equal(tokenStep.with['permission-administration'], 'read');
    assert.equal(tokenStep.with.owner, '${{ github.repository_owner }}');
    assert.equal(tokenStep.with.repositories, '${{ github.event.repository.name }}');
    assert.equal(value.on.workflow_call.secrets['app-private-key'].required, false);
    assert.deepEqual(Object.keys(value.on.workflow_call.outputs).sort(), ['reason', 'runs-on']);
    assert.doesNotMatch(JSON.stringify(job), /checkout|secrets: inherit|pull_request_target/);
});

test('embedded workflow scripts pass caller metadata, paginate API results and emit JSON outputs', async () => {
    const steps = workflow().jobs.select.steps;
    const outputs = {};
    const original = { ...process.env };
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const context = { eventName: 'pull_request', repo: { owner: 'example', repo: 'project' },
        payload: { pull_request: { user: { id: 123 }, head: { repo: { full_name: 'example/project' } } } } };
    const core = { setOutput: (key, value) => { outputs[key] = value; }, info() {} };
    try {
        Object.assign(process.env, { OWNER_ID: '123', RUNNER_LABELS: JSON.stringify(labels),
            HOSTED_FALLBACK: 'ubuntu-latest', APP_CONFIGURED: 'true' });
        await new AsyncFunction('context', 'core', steps[0].with.script)(context, core);
        assert.equal(outputs.eligible, 'true');
        assert.equal(outputs['app-configured'], 'true');
        Object.assign(process.env, { SELECTION_REQUEST: outputs.request, CREDENTIALS_AVAILABLE: 'true' });
        const endpoint = () => {};
        const github = { rest: { actions: { listSelfHostedRunnersForRepo: endpoint } },
            paginate: async (method, parameters) => {
                assert.equal(method, endpoint);
                assert.deepEqual(parameters, { owner: 'example', repo: 'project', per_page: 100 });
                return [runner];
            } };
        await new AsyncFunction('context', 'core', 'github', steps[2].with.script)(context, core, github);
        assert.deepEqual(JSON.parse(outputs['runs-on']), labels);
        process.env.CREDENTIALS_AVAILABLE = 'false';
        await new AsyncFunction('context', 'core', 'github', steps[2].with.script)(context, core, {
            paginate: () => assert.fail('Unavailable App credentials must not use the built-in token for lookup'),
        });
        assert.equal(JSON.parse(outputs['runs-on']), 'ubuntu-latest');
    } finally {
        for (const key of Object.keys(process.env)) if (!Object.hasOwn(original, key)) delete process.env[key];
        Object.assign(process.env, original);
    }
});
