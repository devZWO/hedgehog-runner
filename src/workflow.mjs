export const workflowRepository = 'devZWO/hedgehog-runner';
export const workflowPath = '.github/workflows/select-runner.yml';

/** Produce a fragment, never read or rewrite the consumer's workflow. */
export function workflowExample(config, { job = 'e2e', ref, fallback = 'ubuntu-latest' } = {}) {
    if (!/^[a-z_][a-z\d_-]*$/i.test(job) || job === 'runner_selection') {
        throw new Error('--job must be a GitHub job ID starting with a letter or underscore, other than runner_selection.');
    }
    if (ref !== undefined && !/^[a-f\d]{40}$/i.test(ref)) throw new Error('--ref must be a full 40-character published workflow commit SHA.');
    if (!/^(?:ubuntu|windows|macos)-[a-z\d][a-z\d.-]*$/i.test(fallback)) throw new Error('--fallback must be a hosted ubuntu-*, windows-* or macos-* runner label.');
    if (!config.labels?.length) throw new Error('workflow requires custom runner labels in .hedgehog.json or --label.');
    const labels = JSON.stringify(['self-hosted', 'linux', 'x64', ...config.labels]);
    const expression = (value) => '${{ ' + value + ' }}';
    return [
        `# Runner selection for ${config.repository}. Paste under your existing jobs: mapping.`,
        '# Merge the consumer job fields below into your existing job; keep its steps.',
        '# Preserve existing needs dependencies and required-check job names.',
        ...(ref ? [`# Verify that ${ref} contains ${workflowPath} before using it.`] : [
            '# TEMPLATE ONLY: this package has no published selector commit pinned yet.',
            '# Replace REPLACE_WITH_PUBLISHED_WORKFLOW_COMMIT_SHA with a reviewed full SHA',
            '# containing the reusable workflow, or regenerate with --ref <full-commit-sha>.',
        ]),
        '# Set repository Actions variable RUNNER_OWNER_ID (configure-owner).',
        '# Create/install a GitHub App on this repository with Administration: read.',
        '# Add repository Actions secrets RUNNER_APP_ID and RUNNER_APP_PRIVATE_KEY.',
        '# Missing credentials or an unavailable runner select the hosted fallback.',
        '# Explicitly pass only these secrets; do not use secrets: inherit.',
        '# This is a routing policy, not an access-control boundary for the host.',
        '# Availability is a snapshot; there is no failover after runner assignment.',
        'runner_selection:',
        `  uses: ${workflowRepository}/${workflowPath}@${ref ?? 'REPLACE_WITH_PUBLISHED_WORKFLOW_COMMIT_SHA'}`,
        '  permissions:',
        '    contents: read',
        '  with:',
        `    owner-id: ${expression('vars.RUNNER_OWNER_ID')}`,
        `    labels: '${labels}'`,
        `    fallback: ${fallback}`,
        '  secrets:',
        `    app-id: ${expression('secrets.RUNNER_APP_ID')}`,
        `    app-private-key: ${expression('secrets.RUNNER_APP_PRIVATE_KEY')}`,
        '',
        `${job}:`,
        '  needs: [runner_selection]',
        `  runs-on: ${expression('fromJSON(needs.runner_selection.outputs.runs-on)')}`,
        '  permissions:',
        '    contents: read',
        '  # Keep your existing steps and any additional required permissions here.',
        '',
    ].join('\n');
}
