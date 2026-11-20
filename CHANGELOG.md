# Changelog

## Unreleased

### Features

- Set up and manage repository-scoped GitHub Actions runners on Ubuntu x86-64
  under dedicated Linux accounts, with a pinned and checksum-verified upstream
  runner archive.
- Configure projects with `.hedgehog.json`, CLI overrides and interactive `setup`
  prompts for missing required settings; optionally save reviewed settings.
- Inspect, list, start, stop, rename and remove local installations. `list`,
  `setup` and `remove` request sudo authentication in a terminal when needed.
- Configure the optional repository-wide PR-author variable `RUNNER_OWNER_ID`.
- Provide reusable owner-PR runner selection with a GitHub-hosted fallback and a
  read-only `workflow` generator for existing CI jobs.
- Bundle version-local AI integration guidance, a documentation index, changelog,
  selector snapshot and package identity with official release workflow commits.
- Publish validated npm tarballs through GitHub Releases and npm Trusted Publishing.

### Quality and packaging

- Support `version` as an alternative to `--version` and document npm script
  argument forwarding for help/version flags.
- Validate generated integration examples and repository workflows with pinned,
  checksum-verified actionlint as part of tests and coverage/CI runs.
- Check the exact npm archive allowlist, installed CLI, offline documentation
  links and release metadata before publishing the same tested tarball.

### Migration notes

- Use `setup` instead of the development command `prepare`.
- Use `.hedgehog.json` instead of `.runnerconfig`; there is no discovery fallback.
- Runner names are display names. Repository configuration and the dedicated
  Linux account identify the installation.
- Installed runner versions are identified by `.hedgehog-runner-version` only.

No release date is claimed yet. Before publishing, move these notes under a
`Release v<package-version> (YYYY-MM-DD)` heading for the actual release.
