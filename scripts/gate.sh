#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

step() { printf '\n== %s\n' "$1"; }

step "typecheck"
npm run --silent typecheck

step "lint"
npm run --silent lint

step "tests (UI stories and storage conformance in workerd)"
npm run --silent test

step "build"
npm run --silent build >/dev/null

step "wrangler configs keep public URLs off"
for config in wrangler.jsonc test/conformance/wrangler.jsonc; do
	grep -Eq '"workers_dev":[[:space:]]*false' "$config" || { echo "$config: workers_dev must be false"; exit 1; }
	grep -Eq '"preview_urls":[[:space:]]*false' "$config" || { echo "$config: preview_urls must be false"; exit 1; }
done

step "the deployed config cannot skip the Access check"
if grep -q 'LOCAL_DEV_WITHOUT_ACCESS' wrangler.jsonc; then
	echo "wrangler.jsonc must not set LOCAL_DEV_WITHOUT_ACCESS"
	exit 1
fi

step "no private registry in the lockfile"
others=$(grep -o '"resolved": "https://[^/"]*' package-lock.json | sort -u | grep -v 'registry.npmjs.org' || true)
[ -z "$others" ] || { echo "unexpected registries: $others"; exit 1; }

step "no account IDs or tokens in tracked files"
if git ls-files -z | xargs -0 grep -nE '(account_id|CLOUDFLARE_API_TOKEN)[^\n]*[0-9a-f]{32}' 2>/dev/null; then
	echo "found a secret-looking value"
	exit 1
fi

if [ -n "${BASE:-}" ]; then
	step "kill it five times against $BASE"
	node scripts/kill5.mjs
fi

printf '\nall checks passed\n'
