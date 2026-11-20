import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseDocument } from 'yaml';
import { workflowExample } from '../src/workflow.mjs';
import { runCli } from '../src/runner.mjs';

const config = { repository: 'example/project', labels: ['laptop', 'e2e'] };
// Test-only syntactically valid ref, never advertised as a published workflow commit.
const ref = 'a'.repeat(40);

test('workflow generator prints valid YAML with explicit secrets, label JSON and matching job dependencies', () => {
    const content = workflowExample(config, { job: 'browser_tests', ref, fallback: 'ubuntu-24.04' });
    const parsed = parseDocument(content);
    assert.deepEqual(parsed.errors, []);
    const jobs = parsed.toJS();
    assert.equal(jobs.runner_selection.uses, `devZWO/hedgehog-runner/.github/workflows/select-runner.yml@${ref}`);
    assert.deepEqual(JSON.parse(jobs.runner_selection.with.labels), ['self-hosted', 'linux', 'x64', 'laptop', 'e2e']);
    assert.equal(jobs.runner_selection.with.fallback, 'ubuntu-24.04');
    assert.equal(jobs.runner_selection.with['owner-id'], '${{ vars.RUNNER_OWNER_ID }}');
    assert.deepEqual(Object.keys(jobs.runner_selection.secrets).sort(), ['app-id', 'app-private-key']);
    assert.deepEqual(jobs.browser_tests.needs, ['runner_selection']);
    assert.equal(jobs.browser_tests['runs-on'], '${{ fromJSON(needs.runner_selection.outputs.runs-on) }}');
    assert.match(content, /Keep your existing steps/);
    assert.doesNotMatch(content, /TEMPLATE ONLY/);
});

test('unpublished default is explicitly a template and unsafe job IDs or refs are rejected', () => {
    const template = workflowExample(config, { publishedRef: null });
    assert.match(template, /TEMPLATE ONLY/);
    assert.match(template, /@REPLACE_WITH_PUBLISHED_WORKFLOW_COMMIT_SHA/);
    for (const job of ['runner_selection', 'bad\njob', 'bad:job', '123job', '']) {
        assert.throws(() => workflowExample(config, { job }), /job ID/);
    }
    for (const reference of ['main', 'v1', 'a'.repeat(39), 'a'.repeat(41), 'x'.repeat(40)]) {
        assert.throws(() => workflowExample(config, { ref: reference }), /full 40-character/);
    }
    assert.throws(() => workflowExample(config, { fallback: 'self-hosted' }), /hosted/);
    assert.throws(() => workflowExample({ ...config, labels: [] }), /custom runner labels/);
});

test('workflow CLI uses resolved labels and never changes CI files or invokes host lifecycle', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'hedgehog-workflow-'));
    const output = [];
    const originalLog = console.log;
    console.log = (value) => output.push(value);
    try {
        const path = join(directory, 'config.json');
        const ci = join(directory, 'ci.yaml');
        writeFileSync(path, JSON.stringify({ version: 1, ...config }));
        writeFileSync(ci, 'existing CI contents\n');
        const options = { configOptions: { cwd: directory, configHome: directory,
            user: { uid: 1000, username: 'owner', homedir: directory } }, interactive: true,
            runnerFactory: () => assert.fail('Generator must not invoke host lifecycle'),
            prompt: () => assert.fail('Generator must not prompt'), confirm: () => assert.fail('Generator must not ask to write files') };
        assert.equal(await runCli(['workflow', '--config', path, '--job', 'checks', '--label', 'override', '--ref', ref], options), 0);
        const jobs = parseDocument(output[0]).toJS();
        assert.deepEqual(JSON.parse(jobs.runner_selection.with.labels), ['self-hosted', 'linux', 'x64', 'override']);
        assert.ok(jobs.checks);
        assert.deepEqual(readdirSync(directory).sort(), ['ci.yaml', 'config.json']);
        assert.equal(readFileSync(ci, 'utf8'), 'existing CI contents\n');
        const originalError = console.error;
        const errors = [];
        console.error = (message) => errors.push(message);
        try {
            assert.equal(await runCli(['workflow', '--write', ci], options), 1);
            assert.match(errors.at(-1), /Unknown option '--write'/);
        } finally { console.error = originalError; }
        assert.equal(readFileSync(ci, 'utf8'), 'existing CI contents\n');
    } finally { console.log = originalLog; rmSync(directory, { recursive: true, force: true }); }
});
