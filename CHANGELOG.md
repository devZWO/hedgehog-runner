# Changelog

## Unreleased

No changes yet.

## Release v1.0.0-beta.2 (2026-11-20)

### Release packaging

- Prepare the first automated npm publication through GitHub Actions Trusted
  Publishing, following the manual package bootstrap.
- Publish this prerelease under `next` with CI provenance and the validated npm
  tarball. Official release packages embed their matching selector-workflow commit.
- No CLI or runner lifecycle behavior changes from beta.1.

## Release v1.0.0-beta.1 (2026-11-20)

Prepared for the first public beta. CLI, configuration and workflow interfaces
may still change before the stable 1.0.0 release.

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
