# Hedgehog Runner

[![CI](https://img.shields.io/github/actions/workflow/status/devZWO/hedgehog-runner/ci.yml?branch=main&style=flat-square)](https://github.com/devZWO/hedgehog-runner/actions/workflows/ci.yml)
[![Coverage](https://img.shields.io/codecov/c/github/devZWO/hedgehog-runner?style=flat-square)](https://app.codecov.io/gh/devZWO/hedgehog-runner)
[![npm version](https://img.shields.io/npm/v/%40devzwo%2Fhedgehog-runner?style=flat-square)](https://www.npmjs.com/package/@devzwo/hedgehog-runner)
[![MIT license](https://img.shields.io/github/license/devZWO/hedgehog-runner?style=flat-square)](LICENSE)

Set up a self-hosted GitHub Actions runner on your Ubuntu laptop and start it
when you need it. Hedgehog Runner guides registration and runs GitHub's
runner under a dedicated Linux account.

## Requirements

- Ubuntu x86-64 with systemd, Node.js 24 or later, Git and `sudo` access
- Permission to add a repository-scoped runner in GitHub
- A repository and workflows you trust to execute code on your machine

A separate Linux user reduces access to your personal files. Workflows still
execute code on the same machine. Use this setup for trusted workloads in
private repositories. [GitHub's guidance on self-hosted runner security](https://docs.github.com/en/actions/reference/security/secure-use#hardening-for-self-hosted-runners)

## Quick start

1. Install a specific package version in your repository.

   ```sh
   npm install --save-dev --save-exact @devzwo/hedgehog-runner@0.1.0
   ```

   Add `.runnerconfig` at the root of your checkout. Replace the example
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
   npm exec -- hedgehog-runner prepare
   npm exec -- hedgehog-runner start
   ```

   `prepare` shows the system changes and asks before applying each one.
   Get the short-lived token in **Settings → Actions → Runners → New
   self-hosted runner** and paste it when GitHub's `config.sh` prompts for
   it. The CLI verifies the runner archive against a pinned SHA-256 digest.
   `start` stays in the foreground until you press Ctrl+C. A workflow can
   target the runner with `runs-on: [self-hosted, linux, x64, laptop]`.

## Configuration

The CLI finds `.runnerconfig` at the root of the current Git checkout,
including worktrees. Use `--config <file>` to specify a project file from
outside the checkout.

| Setting | Purpose |
| --- | --- |
| `version` | Configuration format version. Use `1`. |
| `repository` | GitHub repository in `owner/repository` format. |
| `labels` | One or more custom labels passed to GitHub during registration. |
| `configureOwner` | Defaults to `false`. When enabled, `prepare` offers to set the numeric GitHub account ID as the repository Actions variable `RUNNER_OWNER_ID`. An authenticated `gh` can save the variable after confirmation. The CLI also supports manual setup. The workflow decides how to use the variable. |
| `jobEnv` | Optional single-line environment values applied when starting the runner. Keep secrets in GitHub Actions secrets. Runner-owned variables such as `HOME`, `PATH`, `XDG_RUNTIME_DIR` and the `GITHUB_`, `RUNNER_` and `ACTIONS_` namespaces are reserved. |

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

## Commands

| Command | What it does |
| --- | --- |
| `check` | Inspects the host and displays pending setup changes. |
| `prepare` | Applies confirmed changes and guides registration. Run again with the runner stopped to install a newer pinned runner version after updating the CLI. |
| `instructions` | Shows the registration steps and resumes registration in an interactive terminal. |
| `configure-owner` | Runs the optional owner setup independently of local registration. |
| `status` | Shows the local process and registration state and, when enabled, the owner variable status. |
| `start` / `stop` | Starts the runner in the foreground or stops it from another terminal. |
| `rename` | Confirms re-registration with a new display name. The workspace and caches are preserved. |
| `remove` | Prompts to deregister the runner and optionally delete its data and account. |

## Development

Run `npm test` for the Node test suite and `npm run package:check` to install
and check a locally packed tarball. CI generates an LCOV report and publishes
it to Codecov when `CODECOV_TOKEN` is configured.

[MIT License](LICENSE)
