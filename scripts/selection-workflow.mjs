import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { selectionRequest, selectRunner } from '../src/selection.mjs';

// Verified against the upstream v8 / v2 tag commit objects. Update pins explicitly.
const githubScript = 'actions/github-script@ed597411d8f924073f98dfc5c65a23a2325f34cd';
const appToken = 'actions/create-github-app-token@fee1f7d63c2ff003460e3d139729b119787bc349';
const expr = (value) => '${{ ' + value + ' }}';
const scriptBlock = (code) => code.trim().split('\n').map((line) => `            ${line}`).join('\n');

/** Embed tested functions into the pinned workflow; no checkout or runtime source downloads. */
export function selectionWorkflow() {
    const preflight = `const selectionRequest = ${selectionRequest.toString()};
const request = selectionRequest({
    eventName: context.eventName,
    repository: context.repo.owner + '/' + context.repo.repo,
    authorId: context.payload.pull_request?.user?.id,
    headRepository: context.payload.pull_request?.head?.repo?.full_name,
    ownerId: process.env.OWNER_ID,
    labels: process.env.RUNNER_LABELS,
    fallback: process.env.HOSTED_FALLBACK,
});
core.setOutput('request', JSON.stringify(request));
core.setOutput('eligible', String(request.eligible));
core.setOutput('app-configured', process.env.APP_CONFIGURED);
`;
    const select = `const selectRunner = ${selectRunner.toString()};
const request = JSON.parse(process.env.SELECTION_REQUEST);
const result = await selectRunner(request, {
    credentialsAvailable: process.env.CREDENTIALS_AVAILABLE === 'true',
    listRunners: () => github.paginate(github.rest.actions.listSelfHostedRunnersForRepo, {
        ...context.repo, per_page: 100,
    }),
});
core.setOutput('runs-on', JSON.stringify(result.runsOn));
core.setOutput('reason', result.reason);
core.info(result.reason);
`;
    return `# Generated from src/selection.mjs by scripts/selection-workflow.mjs.
# Run npm run workflow:check to detect stale embedded selection code.
name: Select Hedgehog runner

on:
  workflow_call:
    inputs:
      owner-id:
        description: Numeric PR-author GitHub ID (normally vars.RUNNER_OWNER_ID).
        type: string
        default: ''
      labels:
        description: JSON array of all required labels, including self-hosted.
        type: string
        required: true
      fallback:
        description: Hosted ubuntu-*, windows-* or macos-* label.
        type: string
        default: ubuntu-latest
    secrets:
      app-id:
        required: false
      app-private-key:
        required: false
    outputs:
      runs-on:
        description: JSON hosted runner string or array of self-hosted labels.
        value: ${expr('jobs.select.outputs.runs-on')}
      reason:
        description: Explanation of the selection, without API credentials.
        value: ${expr('jobs.select.outputs.reason')}

permissions:
  contents: read

jobs:
  select:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    outputs:
      runs-on: ${expr('steps.select.outputs.runs-on')}
      reason: ${expr('steps.select.outputs.reason')}
    steps:
      - name: Check event and owner eligibility
        id: preflight
        uses: ${githubScript} # v8
        env:
          OWNER_ID: ${expr('inputs.owner-id')}
          RUNNER_LABELS: ${expr('inputs.labels')}
          HOSTED_FALLBACK: ${expr('inputs.fallback')}
          APP_CONFIGURED: ${expr("secrets.app-id != '' && secrets.app-private-key != ''")}
        with:
          script: |
${scriptBlock(preflight)}

      - name: Create repository-scoped runner-read token
        id: app-token
        if: steps.preflight.outputs.eligible == 'true' && steps.preflight.outputs.app-configured == 'true'
        continue-on-error: true
        uses: ${appToken} # v2
        with:
          app-id: ${expr('secrets.app-id')}
          private-key: ${expr('secrets.app-private-key')}
          owner: ${expr('github.repository_owner')}
          repositories: ${expr('github.event.repository.name')}
          permission-administration: read

      - name: Select available runner or hosted fallback
        id: select
        uses: ${githubScript} # v8
        env:
          SELECTION_REQUEST: ${expr('steps.preflight.outputs.request')}
          CREDENTIALS_AVAILABLE: ${expr("steps.app-token.outcome == 'success' && steps.app-token.outputs.token != ''")}
        with:
          github-token: ${expr('steps.app-token.outputs.token || github.token')}
          script: |
${scriptBlock(select)}
`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const path = new URL('../.github/workflows/select-runner.yml', import.meta.url);
    const content = selectionWorkflow();
    if (process.argv.includes('--check')) {
        if (readFileSync(path, 'utf8') !== content) {
            console.error('Selection workflow is stale. Run node scripts/selection-workflow.mjs.');
            process.exitCode = 1;
        }
    } else writeFileSync(path, content);
}
