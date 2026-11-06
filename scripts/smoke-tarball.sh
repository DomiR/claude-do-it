#!/usr/bin/env bash
# Packs dist/npm and runs the tarball the way a user's bunx does: in an empty directory with no repo
# node_modules, under its own DO_IT_HOME and a free port, so it never touches ~/.do-it or port 47100.
# Build first: bun run build:npm
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d)"
export DO_IT_HOME="$work/home" DO_IT_PORT=0 DO_IT_BROWSER=true

cleanup() {
	(cd "$work/app" 2>/dev/null && bunx do-it stop) >/dev/null 2>&1 || true
	rm -rf "$work"
}
trap cleanup EXIT

expected="$(jq -r .version "$root/dist/npm/package.json")"
(cd "$root/dist/npm" && bun pm pack --destination "$work" >/dev/null)
mkdir "$work/app"
cd "$work/app"
bun add "$work"/claude-do-it-*.tgz

version="$(bunx do-it --version)"
echo "do-it --version: $version"
case "$version" in *"$expected"*) ;; *) echo "expected version $expected" >&2; exit 1 ;; esac

printf '# Smoke\n\n- [ ] one task\n' >TODO.md
bunx do-it read TODO.md >/dev/null
status="$(bunx do-it status)"
echo "$status"
case "$status" in *"Daemon pid"*) ;; *) echo "the daemon did not report status" >&2; exit 1 ;; esac
if grep -rq "Cannot find package" "$DO_IT_HOME" 2>/dev/null; then
	grep -r "Cannot find package" "$DO_IT_HOME" >&2
	exit 1
fi
echo "smoke ok"
