#!/bin/bash

# Unified version bump script for extension + manifest + CLI package
# Usage: ./scripts/version-bump-all.sh <major|minor|patch>

set -euo pipefail

if [ $# -eq 0 ]; then
  echo "Usage: $0 <major|minor|patch>"
  echo "Example: $0 patch"
  exit 1
fi

BUMP_TYPE="$1"
CURRENT_VERSION=$(node -p "require('./package.json').version")

if [ "$BUMP_TYPE" = "major" ]; then
  NEW_VERSION=$(echo "$CURRENT_VERSION" | awk -F. '{print $1+1".0.0"}')
elif [ "$BUMP_TYPE" = "minor" ]; then
  NEW_VERSION=$(echo "$CURRENT_VERSION" | awk -F. '{print $1"."$2+1".0"}')
elif [ "$BUMP_TYPE" = "patch" ]; then
  NEW_VERSION=$(echo "$CURRENT_VERSION" | awk -F. '{print $1"."$2"."$3+1}')
else
  echo "Invalid bump type: $BUMP_TYPE"
  echo "Must be: major, minor, or patch"
  exit 1
fi

echo "Bumping all versions from $CURRENT_VERSION to $NEW_VERSION"

# 1) Root extension package version (+ lockfile)
pnpm version "$NEW_VERSION" --no-git-tag-version

# 2) Extension manifest version
node -e '
  const fs = require("fs");
  const path = "src/manifest.json";
  const version = process.argv[1];
  const manifest = JSON.parse(fs.readFileSync(path, "utf8"));
  manifest.version = version;
  fs.writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
' "$NEW_VERSION"
echo "✓ Updated src/manifest.json"

# 3) CLI package version (+ CLI lockfile)
(
  cd cli
  pnpm version "$NEW_VERSION" --no-git-tag-version
)
echo "✓ Updated cli/package.json"

# Keep dist manifest aligned if present (nice-to-have for local builds)
if [ -f "dist/manifest.json" ]; then
  node -e '
    const fs = require("fs");
    const path = "dist/manifest.json";
    const version = process.argv[1];
    const manifest = JSON.parse(fs.readFileSync(path, "utf8"));
    manifest.version = version;
    fs.writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
  ' "$NEW_VERSION"
  echo "✓ Updated dist/manifest.json"
fi

# Safety check to prevent partial bumps
node -e '
  const pkg = require("./package.json").version;
  const manifest = require("./src/manifest.json").version;
  const cli = require("./cli/package.json").version;
  if (!(pkg === manifest && manifest === cli)) {
    console.error("Version mismatch after bump:", { pkg, manifest, cli });
    process.exit(1);
  }
  console.log(`✓ Version sync verified: ${pkg}`);
'

echo ""
echo "✅ Unified version bump complete"
echo ""
echo "Updated files:"
echo "  - package.json"
echo "  - pnpm-lock.yaml"
echo "  - src/manifest.json"
echo "  - cli/package.json"
echo "  - cli/pnpm-lock.yaml"
