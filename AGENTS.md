# Hedgehog Runner

Hedgehog Runner is a Node.js CLI for repository-scoped GitHub Actions runners
on Ubuntu x86-64. Keep its host lifecycle independent of the workflows and
services that run on it. Treat the README as the user-facing configuration and
operation reference.

- Keep host inspection read-only. Show system changes and obtain interactive
  confirmation before applying or deleting setup state. Run the runner and
  account-owned file operations as the dedicated Linux account.
- Let the upstream `config.sh` prompt for registration and removal tokens.
  Keep tokens out of arguments, configuration files, logs and fixtures.
- Verify the SHA-256 digest against the upstream Linux x64 release before
  changing the pinned runner version, archive URL or digest.
- Inject or simulate host and GitHub operations in tests. Use a designated
  Ubuntu test host for intentional manual registration or host mutations.
- Run `npm test` for code changes and `npm run package:check` for changes to
  the executable, package contents or configuration entry point.
