#!/usr/bin/env bash
# Release md-agent: test, build, bump, push, GitHub release, npm publish.
#
#   ./release.sh              publish the version already tagged (e.g. after a bump done elsewhere)
#   ./release.sh minor        bump (patch|minor|major), then do everything
#   ./release.sh minor 123456 same, with the npm OTP given up front
#
# npm publish needs your authenticator code; the script asks for it if not given.
set -euo pipefail
cd "$(dirname "$0")"

BUMP="${1:-}"
OTP="${2:-}"

if [[ -n "$(git status --porcelain)" ]]; then
  echo "working tree not clean — commit or stash first" >&2; git status --short; exit 1
fi

npm test
npm run build

if [[ -n "$BUMP" ]]; then
  npm version "$BUMP" -m "release: v%s"
fi
VERSION="$(node -p "require('./package.json').version")"

git push origin main --tags

if ! gh release view "v$VERSION" >/dev/null 2>&1; then
  gh release create "v$VERSION" --title "v$VERSION" --generate-notes
fi

if [[ -z "$OTP" ]]; then
  read -r -p "npm OTP for publishing v$VERSION: " OTP
fi
npm publish --access public --otp="$OTP"

npm install -g . >/dev/null
md-agent skill install >/dev/null
echo "released v$VERSION — npm, GitHub, global install and skill all updated"
