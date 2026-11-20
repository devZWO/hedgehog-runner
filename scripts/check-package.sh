#!/usr/bin/env bash
set -euo pipefail

tmp="$(mktemp -d)"
trap 'rm -rf -- "$tmp"' EXIT

package="$(npm pack --cache "$tmp/npm-cache" --pack-destination "$tmp" --silent)"
npm install --cache "$tmp/npm-cache" --prefix "$tmp" --ignore-scripts --no-audit --no-fund "$tmp/$package" >/dev/null
cd "$tmp"
./node_modules/.bin/hedgehog-runner --help | tee help.txt
grep -q 'Usage: hedgehog-runner' help.txt
grep -q -- '--job-env' help.txt
grep -q 'List local installations' help.txt
grep -q 'workflow.*Print a CI runner-selection' help.txt
./node_modules/.bin/hedgehog-runner workflow --repository example-org/example-repo --label laptop --job e2e > workflow.yml
grep -q 'TEMPLATE ONLY' workflow.yml
grep -q 'REPLACE_WITH_PUBLISHED_WORKFLOW_COMMIT_SHA' workflow.yml
grep -q 'runner_selection:' workflow.yml
