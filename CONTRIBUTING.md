# Contributing

Use Node.js 24 or later on Ubuntu x86-64 with Git and tar. Run `npm ci` to install
the development dependencies. The published CLI has no production dependencies.
Read [AGENTS.md](AGENTS.md) and use the [README](README.md) as the operation and
configuration reference.

## Scope and host safety

Keep host lifecycle separate from the workflows and services that execute on a
runner. Keep host inspection read-only. Show system changes and require
interactive confirmation before applying or deleting setup state. Execute runner
and account-owned file operations as the dedicated Linux account.

GitHub's upstream `config.sh` prompts for registration/removal tokens. Do not put
them in CLI arguments, environment variables, configuration, logs or fixtures.
Update the pinned runner version, archive URL and SHA-256 together only after
verifying the digest against the upstream Linux x64 release.

Use injected/simulated host and GitHub operations in tests. Intentional manual
registration and host mutations belong on a designated Ubuntu test host, not on
a contributor's working machine or an agent's execution container.

## Checks and documentation

Before opening a pull request, run:

```sh
npm run release:check
```

This checks generated workflow source, runs coverage and tests (including
actionlint), and packs, audits and installs the actual npm tarball. Individual
checks are `npm test`, `npm run test:coverage`, `npm run workflow:check`,
`npm run workflow:lint` and `npm run package:check`.

The first workflow lint downloads pinned actionlint into a project-local cache,
verifies its SHA-256, and requires no sudo. See the [development reference](README.md#development)
for offline setup. Keep meaningful behavior tests and restore modified globals.
Use Conventional Commits, for example `feat:`, `fix:`, `docs:` or `chore:`.

Update README, CLI help, [the AI integration guide](ai/usage.md), and
[CHANGELOG.md](CHANGELOG.md) when user behavior changes. The AI guide is shipped
with the installed version and must describe the actual CLI, not a future release.
Keep local documentation links valid. `llms.txt` is the consumer-facing index;
repository `AGENTS.md` and this contribution guide are development material.

After changing `src/selection.mjs`, regenerate the immutable selector content:

```sh
node scripts/selection-workflow.mjs
```

Review `.github/workflows/select-runner.yml` and run the checks. The selector
must not check out or execute caller/PR code. Keep internal Action pins at
verified full commit SHAs, explicit secret passing and minimal permissions.
Our own CI and publishing workflows use major-version Action tags such as `@v6`.
The full-SHA policy applies to the reusable selector and its consumer reference.

## Package contract

`package.json#files` enumerates runtime modules and the reviewed offline
integration documents. `scripts/check-package.mjs` enforces the exact archive
list and checks the installed CLI, local documentation links and selector digest.
If intentional package contents change, update both lists and their tests.
Do not ship tests, development scripts, caches, source-repository policies,
credentials, machine profiles or the unneeded selection-build module.

`npm pack` runs `prepack`, which copies the canonical selector into
`docs/select-runner.yml` and writes `docs/package-info.json`. Both generated files
are ignored by Git and included explicitly in npm. Do not edit them by hand.
They contain no timestamp, so equivalent package inputs remain reproducible.

Official clean GitHub Release builds record their release commit as the default
workflow pin. Local/development builds leave that pin unset and the generator
marks its output as a template. A source commit alone is not evidence that the
workflow has been published. `--ref` can explicitly choose another reviewed SHA.

## Configure publishing once

The workflow in `.github/workflows/publish.yml` uses npm Trusted Publishing
(OIDC), not an `NPM_TOKEN` secret. Publishing needs npm 11.5.1+; the workflow uses
the current Node.js 24 release on a GitHub-hosted Ubuntu runner.

As the package owner, configure npm's trusted publisher for
`@devzwo/hedgehog-runner` with these exact values:

| Field | Value |
| --- | --- |
| GitHub organization/user | `devZWO` |
| Repository | `hedgehog-runner` |
| Workflow filename | `publish.yml` |
| Environment | `npm` |
| Allowed publishing action | Enable direct `npm publish`. |

Create the GitHub environment `npm`, restrict its deployment branches/tags, and
configure required reviewers as appropriate. Protect release tags and review
publishing workflow changes. If the package does not exist yet, complete npm's
initial package/bootstrap setup as the package owner before relying on this
workflow. A newly configured trusted publisher must be validated by its first
successful publish within npm's documented expiry period. Consult the current
[npm trusted-publishing reference](https://docs.npmjs.com/trusted-publishers/).

Provenance is requested explicitly. The workflow grants `id-token: write` only
to the publishing job and uses the public package's matching repository metadata.
CODECOV_TOKEN is optional and only passed to validation. The publishing job
receives the tested tarball and its SHA-256, checks the digest and publishes that
exact file with lifecycle scripts disabled; it never rebuilds the package.

## Prepare a release

1. Update `package.json` and `package-lock.json` to the intended version. For a
   prerelease, use a SemVer prerelease suffix such as `0.2.0-beta.1`.
2. Move the relevant Unreleased notes to `## Release v<version> (YYYY-MM-DD)` in
   CHANGELOG.md, using the actual release date. Do not invent historical releases.
3. Run `npm run release:check`, review the package audit and commit all changes.
4. Create/push tag `v<version>` for that reviewed commit and publish a GitHub
   Release for it. Stable versions must be regular releases; prerelease versions
   must be marked as prereleases. The workflow verifies tag, version, lockfile,
   changelog date and clean checkout before making an artifact available.
5. The publish workflow reuses CI, uploads the validated tarball, waits for the
   `npm` environment rules, then publishes with provenance. Stable releases use
   npm dist-tag `latest`; prereleases use `next`. Concurrent publishes are queued.
6. Check the GitHub run and npm package, including provenance, offline docs,
   `--version` and the generated release workflow pin. A version already published
   on npm cannot be overwritten; prepare a new version for corrections.

No npm publication or external account configuration is performed merely by
running tests, package checks or editing the workflow file.

Be respectful in issues and reviews. Contributions are submitted under the MIT
license. Only submit material you have the right to contribute.
