#!/usr/bin/env bash
set -euo pipefail

tmp="$(mktemp -d)"
trap 'rm -rf -- "$tmp"' EXIT

package="$(npm pack --cache "$tmp/npm-cache" --pack-destination "$tmp" --silent)"
npm install --cache "$tmp/npm-cache" --prefix "$tmp" --ignore-scripts --no-audit --no-fund "$tmp/$package" >/dev/null
cd "$tmp"
./node_modules/.bin/hedgehog-runner --help | tee help.txt
grep -q 'Usage: hedgehog-runner' help.txt
