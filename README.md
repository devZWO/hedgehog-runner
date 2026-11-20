# Hedgehog Runner

[![CI](https://img.shields.io/github/actions/workflow/status/devZWO/hedgehog-runner/ci.yml?branch=main&style=flat-square)](https://github.com/devZWO/hedgehog-runner/actions/workflows/ci.yml)
[![Coverage](https://img.shields.io/codecov/c/github/devZWO/hedgehog-runner?style=flat-square)](https://app.codecov.io/gh/devZWO/hedgehog-runner)
[![npm version](https://img.shields.io/npm/v/%40devzwo%2Fhedgehog-runner?style=flat-square)](https://www.npmjs.com/package/@devzwo/hedgehog-runner)
[![MIT license](https://img.shields.io/github/license/devZWO/hedgehog-runner?style=flat-square)](LICENSE)

Set up a self-hosted GitHub Actions runner on your Ubuntu laptop and start it
when you need it. Hedgehog Runner guides registration and runs GitHub's
runner under a dedicated Linux account.

For AI-assisted project integration, start with the [local AI guide](ai/usage.md).
It is included at `node_modules/@devzwo/hedgehog-runner/ai/usage.md` together with
this README, [CHANGELOG.md](CHANGELOG.md), [llms.txt](llms.txt), version identity
and an exact selector-workflow snapshot. Prefer the installed version's files
over documentation from a different release. `hedgehog-runner --version` identifies
the installed CLI.

## Requirements

- Ubuntu x86-64 with systemd, Node.js 24 or later, Git and `sudo` access
- Permission to add a repository-scoped runner in GitHub
- A repository and workflows you trust to execute code on your machine

A separate Linux user reduces access to your personal files. Workflows still
execute code on the same machine. Use this setup for trusted workloads in
private repositories. [GitHub's guidance on self-hosted runner security](https://docs.github.com/en/actions/reference/security/secure-use#hardening-for-self-hosted-runners)

## Quick start

1. Install a specific published package version in your repository. Replace
   `VERSION` with the intended exact release; for an existing installation,
   read its package.json rather than silently selecting a different version.

   ```sh
   npm install --save-dev --save-exact @devzwo/hedgehog-runner@VERSION
   ```

   Add `.hedgehog.json` at the root of your checkout. Replace the example
   repository with yours and use the same custom label in your workflow.

   ```json
   {
     "version": 1,
     "repository": "example-org/example-repo",
     "labels": ["laptop"],
     "configureOwner": false,
     "jobEnv": {}
   }
   ```

2. Inspect the host and follow the registration prompts.

   ```sh
   npm exec -- hedgehog-runner check
   npm exec -- hedgehog-runner setup
   npm exec -- hedgehog-runner start
   ```

   `setup` shows the system changes and asks before applying each one.
   Get the short-lived token in **Settings → Actions → Runners → New
   self-hosted runner** and paste it when GitHub's `config.sh` prompts for
   it. The CLI verifies the runner archive against a pinned SHA-256 digest.
   `start` stays in the foreground until you press Ctrl+C. A workflow can
   target the runner with `runs-on: [self-hosted, linux, x64, laptop]`.

You can also start without a configuration file. In an interactive terminal,
`hedgehog-runner setup` asks for the missing repository and custom labels, shows
the resolved settings, and offers to save them before continuing with host setup.
Or supply the settings directly:

```sh
hedgehog-runner setup --repository example-org/example-repo --label laptop
```

## Configuration

The CLI finds `.hedgehog.json` at the root of the current Git checkout,
including worktrees. Outside a checkout it looks in the current directory.
Use `--config <file>` for another JSON file. An explicitly selected file must
exist and be readable. The default file is optional; `.runnerconfig` is no
longer discovered.

**CLI options override file settings, which override defaults.** Options work
before or after any lifecycle command and can be combined with `--config`.
Every command except `list` needs a repository. `setup`, `instructions`, `rename`
and `workflow` also need at least one custom label. Only `setup` asks for missing
required settings, and only in an interactive terminal. Other commands and
noninteractive invocations report the missing setting and the corresponding
option. Invalid supplied values or malformed files produce errors instead of
being replaced by interactive questions.

| Setting | Purpose |
| --- | --- |
| `version` | Configuration format version. Use `1`. |
| `repository` | GitHub repository in `owner/repository` format. |
| `labels` | One or more custom labels passed to GitHub during registration. |
| `configureOwner` | Defaults to `false`. Enables the optional [PR-owner configuration](#configure-the-pr-owner): select whose pull requests a compatible workflow should prefer to run on your local runner. Stores the selected GitHub account's numeric ID in the repository Actions variable `RUNNER_OWNER_ID`. |
| `jobEnv` | Optional single-line environment values applied when starting the runner. Keep secrets in GitHub Actions secrets. Runner-owned variables such as `HOME`, `PATH`, `XDG_RUNTIME_DIR` and the `GITHUB_`, `RUNNER_` and `ACTIONS_` namespaces are reserved. |

| CLI option | Configuration equivalent |
| --- | --- |
| `--repository owner/repo` | `repository` |
| `--label laptop --label e2e` | Replaces the complete `labels` array. |
| `--configure-owner` / `--no-configure-owner` | Sets `configureOwner` to `true` / `false`. The two options cannot be combined. |
| `--job-env CACHE_DIR=/tmp/cache --job-env MODE=local` | Replaces the complete `jobEnv` map. Values may contain `=`; empty values are supported. Duplicate keys are rejected. |
| `--account gha-existing` | Overrides `account` in the local profile. |
| `--runner-name my-laptop` | Overrides `runnerName` in the local profile. |
| `--job e2e` | `workflow` only: ID of the existing workload job to show in the YAML fragment (default `e2e`). |
| `--ref <full-commit-sha>` | `workflow` only: override the bundled release workflow commit with another reviewed 40-character SHA. Development packages without a bundled pin print a template placeholder. |
| `--fallback ubuntu-latest` | `workflow` only: hosted fallback label. Defaults to `ubuntu-latest`; supports `ubuntu-*`, `windows-*` and `macos-*` labels. Choose a label available to your repository. |

`version` describes the file format and has no CLI option. Omitting optional
settings uses `configureOwner: false`, `jobEnv: {}` and the derived account/name.
For booleans, use `--no-configure-owner` to override `true` from a file.
CLI arguments can appear in shell history and process listings; keep secrets in
GitHub Actions secrets. Registration and removal tokens are accepted only by
GitHub's interactive `config.sh` prompts.

When values are supplied or entered during interactive `setup`, the CLI shows
the project file and any local profile changes and asks before saving them.
Without a checkout, the save destination defaults to the current directory.
CLI overrides are otherwise temporary. If you decline saving, pass the same
settings again on later commands, for example:

```sh
hedgehog-runner start --repository example-org/example-repo --job-env MODE=local
hedgehog-runner status --repository example-org/example-repo
```

Local options live in
`${XDG_CONFIG_HOME:-$HOME/.config}/hedgehog-runner/<owner>/<repository>.json`.
Use lowercase path components. By default, the CLI derives a dedicated Linux
account from the repository slug and builds the GitHub runner name from the
hostname and a verified GitHub login. You can override both locally.

```json
{
  "account": "gha-example",
  "runnerName": "my-laptop"
}
```

Use one dedicated Linux account per runner. For an existing setup, set
`account` to its existing dedicated user and run `sudo -v` followed by
`hedgehog-runner check`. If the registration already points to the configured
repository, it can be reused. The CLI preserves existing entries outside its
managed section in the runner's `.env`. Review any old environment settings
when switching setup tools.

By default, one runner is selected per repository on this host. Multiple runners
for the same repository require different dedicated accounts; select each one
with `--account`. The local profile stores one account selection per repository.
Runner display names do not identify installations and can be reused across
repositories.

## Commands

| Command | What it does |
| --- | --- |
| `check` | Inspects the host and displays pending setup changes. |
| `setup` | Applies confirmed changes and guides registration. Run again with the runner stopped to install a newer pinned runner version after updating the CLI. |
| `instructions` | Shows the registration steps and resumes registration in an interactive terminal. |
| `configure-owner` | Selects the GitHub account whose PRs a compatible workflow should prefer to run locally, and configures its numeric ID as `RUNNER_OWNER_ID`. Can run independently of runner setup or registration. Requires `configureOwner: true` or `--configure-owner`. |
| `status` | Shows the local process and registration state and, when enabled, the owner variable status. |
| `list` | Lists local installations grouped by their registered GitHub repository, without project configuration. Requests sudo authentication in an interactive terminal if needed. |
| `workflow` | Prints a copy/paste YAML fragment for reusable runner selection and an existing workload job. Uses resolved project/CLI configuration; does not edit files or contact GitHub. |
| `start` / `stop` | Starts the runner in the foreground or stops it from another terminal. |
| `rename` | Confirms re-registration with a new display name. The workspace and caches are preserved. |
| `remove` | Prompts to deregister the runner and optionally delete its data and account. |
| `version` / `--version` | Shows the installed Hedgehog Runner package version without configuration or host inspection. |
| `help` / `--help` / `-h` | Shows CLI usage and options. |

When invoking a package.json script such as `"runner": "hedgehog-runner"`
(or this repository's `"runner": "node src/cli.mjs"`), use subcommands directly:

```sh
npm run runner help
npm run runner version
```

Flags need an additional `--` separator so npm forwards them to the CLI:

```sh
npm run runner -- --help
npm run runner -- --version
```

Without that separator, `npm run runner --version` displays npm's own version.
Direct `hedgehog-runner --version` and `hedgehog-runner --help` remain supported.

### Configure the PR owner

Use this optional feature when your workflow should prefer a local runner for
pull requests authored by a particular GitHub account. For example, you may want
your own PRs to run E2E tests on your laptop while other PRs use GitHub-hosted
runners. `configure-owner` selects that PR author and stores their numeric GitHub
account ID in the repository Actions variable `RUNNER_OWNER_ID`.

```sh
hedgehog-runner configure-owner --repository example-org/example-repo --configure-owner
```

With `configureOwner: true` in `.hedgehog.json` (or `--configure-owner`), `setup`
includes this step automatically. You can also run it separately before or after
registration, or later to change the selected account. No local runner or labels
are needed for this command.

The command proposes the authenticated `gh` account, or lets you enter another
GitHub username. It verifies the account and asks for confirmation. Authenticated
`gh` can write the variable with Actions variables write access. Without it, the
CLI verifies the username through GitHub's public API and shows the exact ID and
GitHub settings page for manual configuration, then asks you to confirm completion.
The value is configuration, not a secret; no personal access token is requested.

**Your workflow must opt into runner selection.** `RUNNER_OWNER_ID` is a
convention used by cooperating workflows; GitHub does not automatically route jobs
based on it, and `configure-owner` does not install or edit a workflow. Use the
[workflow generator](#generate-ci-integration) to integrate the reusable selector.
It compares `github.event.pull_request.user.id` with `vars.RUNNER_OWNER_ID`, checks
that the PR comes from the same repository, and queries whether a runner with all
required labels is online and idle before choosing its `runs-on` value.

Matching same-repository owner PRs prefer an available local runner. Other PRs,
pushes to `main`, missing or invalid owner configuration, and failed availability
checks use the hosted fallback, which defaults to `ubuntu-latest`. The reusable
selector supports configurable labels and a hosted fallback. Availability is
checked before selection; it does not guarantee failover if a runner goes offline
after a job has been assigned.

The variable selects one PR-author account for the entire repository, not a
separate owner for each installed runner. Changing it affects every workflow that
uses it. It does not restrict which workflows may use a self-hosted runner, change
the Linux account, or rename an existing registration. Runner labels and workflow
selection determine where jobs run; the display name is informational.

### Generate CI integration

```sh
hedgehog-runner workflow --job e2e
```

The command reads `.hedgehog.json` (or `--config`) and applies the usual CLI
overrides. It prints a YAML fragment to standard output, ready to merge under the
existing `jobs:` mapping in your CI workflow. No file is written, and there is no
`--write` option. It performs no sudo or GitHub API operations. Successful `setup`
prints a reminder about this command.

The fragment contains a `runner_selection` job and the `needs` / `runs-on` fields
for your existing `e2e` job. Keep the existing job's steps, name and settings, merge
its existing dependencies into `needs`, and preserve any additional permissions
it requires. This matters for required checks and jobs that already depend on
builds or other quality gates. `--job` selects another existing job ID. The label
list includes `self-hosted`, `linux`, `x64` and your configured custom labels.

Official release packages embed the release's immutable workflow commit and use
it by default. Inspect [package identity](docs/package-info.json) and the
[bundled selector snapshot](docs/select-runner.yml) for the exact installed version.
The remote reference points to
`devZWO/hedgehog-runner/.github/workflows/select-runner.yml` at that commit.

Local/development packages do not claim that their source is published. Without
a release pin, the output says **TEMPLATE ONLY** and includes
`REPLACE_WITH_PUBLISHED_WORKFLOW_COMMIT_SHA`. Replace it with a reviewed published
SHA, or explicitly choose another reviewed version with:

```sh
hedgehog-runner workflow --job e2e --ref "$SELECTOR_COMMIT_SHA"
```

Set `SELECTOR_COMMIT_SHA` to the actual published SHA first. The generator checks
its format offline; you must verify that the commit belongs to this repository
and contains the workflow. It deliberately does not guess a SHA from your local
checkout or reference `main` or a mutable tag. Use `--repository owner/repo
--label laptop` to generate a fragment without a project configuration file.

The reusable workflow accepts:

| Input | Purpose |
| --- | --- |
| `owner-id` | Numeric GitHub account ID, normally `${{ vars.RUNNER_OWNER_ID }}`. Missing/invalid IDs select the hosted fallback. |
| `labels` | JSON array of all required labels, including `self-hosted`. Every label must match on an online, idle runner. |
| `fallback` | Hosted runner label; defaults to `ubuntu-latest`. Invalid label syntax uses `ubuntu-latest`. |
| Secret `app-id` | GitHub App ID; optional, passed explicitly from `RUNNER_APP_ID`. |
| Secret `app-private-key` | GitHub App private key; optional, passed explicitly from `RUNNER_APP_PRIVATE_KEY`. |
| Output `runs-on` | JSON string for a hosted label or JSON array of self-hosted labels, consumed with `fromJSON(...)`. |
| Output `reason` | Human-readable decision reason, without API errors or credentials. |

The selector runs on `ubuntu-latest`, with a five-minute job timeout. Non-owner
PRs, forks and events other than `pull_request` use the hosted fallback without
requesting an App token or querying runners. Missing credentials, token creation
failures, API errors and no matching idle runner also select the hosted fallback.
The availability query paginates through the caller repository's runners.

### GitHub App setup and trust boundaries

1. Create a GitHub App with repository permission **Administration: Read-only**,
   which GitHub requires for listing repository runners. Disable webhooks if you
   do not otherwise need them. See [GitHub App registration](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app).
2. Install it only on the consuming repository. Record its **App ID**, generate a
   private key, and add repository Actions secrets `RUNNER_APP_ID` and
   `RUNNER_APP_PRIVATE_KEY`. The generator prints only these names, never values.
3. Configure the numeric `RUNNER_OWNER_ID` Actions variable with `configure-owner`.
4. Review and pin the reusable workflow to a full commit SHA, then merge the
   generated fragment. For private workflow repositories, configure their Actions
   access policy to allow the caller. The workflow must also be allowed by the
   caller's repository/organization Actions policy.

`jobs.<job>.uses: owner/repo/.github/workflows/file.yml@sha` calls a reusable
workflow declaring `on: workflow_call`. `steps[].uses` calls an Action, which can
use JavaScript, composite steps or Docker; `uses` does not imply a Docker image.
See [reusing workflows](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows).

The selection job executes only code embedded in the pinned reusable workflow.
It does not check out or execute the caller's PR code. Its internal Actions are
also pinned to verified full SHAs. The temporary App installation token is limited
to the caller repository and `Administration: read`; it is created only for an
eligible PR and is not returned as a workflow output or sent to the workload job.
Secrets are passed individually, without `secrets: inherit`. The workflow uses
`contents: read` for its built-in `GITHUB_TOKEN`; App-token permissions are separate.

The App private key remains a powerful credential. Keep its installation and
permissions narrow and trust every workflow to which you expose it. A PR author
with permission to alter the caller workflow may change how repository secrets
are used; the selector's owner check is not a general protection for those secrets.
Avoid running untrusted PR code with secrets via `pull_request_target`. Treat
self-hosted runner workloads as trusted code with access to the runner's host;
the owner rule and a dedicated Linux account do not provide complete isolation.
See [GitHub's secure-use guidance](https://docs.github.com/en/actions/reference/security/secure-use).

### Remove a runner

To remove a runner without a checkout or project configuration file, select its
repository explicitly. This works from any directory and does not read a project
configuration, even if one exists in the current checkout.
If you explicitly pass `--config`, that file is loaded and CLI settings override
its values as usual.

```sh
hedgehog-runner remove --repository example-org/example-repo
```

The CLI uses the account from that repository's local profile, or the default
account derived from its repository slug. For a different dedicated account,
override it explicitly:

```sh
hedgehog-runner remove --repository example-org/example-repo --account gha-existing
```

No labels or runner name are required. The account's installation and its stored
GitHub registration identify the runner; the registration must match the selected
repository. The CLI shows the target and asks for confirmation before deregistering
or deleting data. The runner must be stopped first. GitHub's `config.sh` requests
the removal token interactively. A missing account or mismatched registration
produces an error with the selected target.

### List local installations

```sh
hedgehog-runner list
```

`list` enumerates dedicated `gha-*` Linux accounts and inspects their standard
`/home/<account>/actions-runner` directories as those accounts. It displays the
registered name, Linux account and directory under each repository, so multiple
runners and identical names remain distinguishable. It lists local installations,
not every runner registered in GitHub or installations outside this account/path
convention. It accepts no configuration options and works outside a checkout.

Directories without registration metadata appear under **Unregistered
installations**. Unreadable accounts, invalid metadata or unexpected account home
directories appear under **Unverified accounts**. Partial inventory exits with
code `1`; complete inventory, including no installed runners, exits with `0`.
In an interactive terminal, `list` requests sudo authentication once if protected
account files cannot be inspected with the current credentials, then retries the
read. It does not request authentication when no dedicated accounts need to be
inspected or the reads already succeed. Host inspection remains read-only.

`setup` and `remove` also handle sudo authentication automatically and reuse
valid cached credentials. No preceding `sudo -v` is needed for these commands
in an interactive terminal. Password input is handled directly by sudo; the CLI
does not read or store the password. Authentication failures and installation
access errors are reported separately. Setup and deletion still require their
individual confirmations.

A WebStorm Run console without a terminal cannot show the sudo password prompt.
Use WebStorm's integrated Terminal (`Alt+F12`) instead. Without a terminal,
`list` reports incomplete results with an authentication hint when necessary;
`setup` and `remove` require a terminal for confirmations even when sudo is
already authenticated. `check` and `status` continue using noninteractive reads;
run `sudo -v` in the same terminal first to include protected account details.

## Development

See [CONTRIBUTING.md on GitHub](https://github.com/devZWO/hedgehog-runner/blob/main/CONTRIBUTING.md)
for contribution rules, release preparation and npm Trusted Publishing setup.
The publish workflow validates a GitHub Release, tests the actual tarball, then
publishes that same artifact with OIDC and provenance through the `npm` environment.
Stable versions use `latest`; SemVer prereleases use `next`. Creating the workflow
file does not configure npm trust or publish a package.

Run `npm test` for the Node test suite and `npm run package:check` to install
and check a locally packed tarball. Run `npm ci` first to install the development
YAML parser used by tests. `npm run workflow:check` checks that the committed
selector workflow embeds the current tested selection functions. After editing
`src/selection.mjs`, regenerate it with `node scripts/selection-workflow.mjs`.
`npm test` and `npm run test:coverage` refresh ignored package metadata, then run
`npm run workflow:lint`: actionlint
checks every repository workflow plus completed generator examples against the
actual local reusable-workflow interface. Thus malformed expressions, unknown
inputs or mismatched secret names fail tests, not just a one-time manual check.
On the supported Linux x86-64 development host, the first lint run downloads
actionlint 1.7.12 from its official release into `node_modules/.cache/hedgehog-runner`.
The pinned SHA-256 is verified before execution on every run; no sudo is used.
Later runs work offline with the cached archive. For an offline first run, set
`HEDGEHOG_ACTIONLINT_ARCHIVE` to a predownloaded copy of the exact official
`actionlint_1.7.12_linux_amd64.tar.gz`; its digest is still checked. Optional system
shellcheck and pyflakes integration is disabled to keep results reproducible.
The generated workflow needs no checkout, npm installation or runtime download
of selection source. CI generates an LCOV report and publishes
it to Codecov when `CODECOV_TOKEN` is configured.

`npm pack` prepares the offline documentation automatically. `package:check`
enforces an exact archive allowlist: five runtime modules, package manifest,
license, README, AI guide, changelog, documentation index, selector snapshot and
package identity. It rejects unexpected files and validates local documentation
links, the installed CLI version and the snapshot digest. Tests, developer tools,
repository AGENTS.md, CONTRIBUTING.md, caches and the build-only selection module
stay outside the npm bundle. The package has no production dependencies or
install-time host setup scripts.

[MIT License](LICENSE)
