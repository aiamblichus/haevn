#!/bin/bash

# Version bump script for HAEVN CLI package
# Usage: ./scripts/cli-version-bump.sh <major|minor|patch>

set -e

if [ $# -eq 0 ]; then
  echo "Usage: $0 <major|minor|patch>"
  echo "Example: $0 patch"
  exit 1
fi

BUMP_TYPE=$1

CURRENT_VERSION=$(node -p "require('./cli/package.json').version")

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

echo "Bumping CLI version from $CURRENT_VERSION to $NEW_VERSION"

(
  cd cli
  pnpm version "$NEW_VERSION" --no-git-tag-version
)

echo ""
echo "✅ CLI version bumped to $NEW_VERSION"
echo ""
echo "Next steps:"
echo "  1. Review changes: git diff -- cli/package.json cli/pnpm-lock.yaml"
echo "  2. Commit changes: git add cli/package.json cli/pnpm-lock.yaml && git commit -m 'chore(cli): bump version to $NEW_VERSION'"
echo "  3. Create tag: git tag -a cli-v$NEW_VERSION -m 'CLI release $NEW_VERSION'"
echo "  4. Push: git push upstream main && git push upstream cli-v$NEW_VERSION"
