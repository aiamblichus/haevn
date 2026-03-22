#!/bin/bash

# Version bump script for HAEVN
# Usage: ./scripts/version-bump.sh <major|minor|patch>

set -e

if [ $# -eq 0 ]; then
    echo "Usage: $0 <major|minor|patch>"
    echo "Example: $0 patch"
    exit 1
fi

BUMP_TYPE=$1

# Get current version from package.json
CURRENT_VERSION=$(node -p "require('./package.json').version")

# Calculate new version
if [ "$BUMP_TYPE" = "major" ]; then
    NEW_VERSION=$(echo $CURRENT_VERSION | awk -F. '{print $1+1".0.0"}')
elif [ "$BUMP_TYPE" = "minor" ]; then
    NEW_VERSION=$(echo $CURRENT_VERSION | awk -F. '{print $1"."$2+1".0"}')
elif [ "$BUMP_TYPE" = "patch" ]; then
    NEW_VERSION=$(echo $CURRENT_VERSION | awk -F. '{print $1"."$2"."$3+1}')
else
    echo "Invalid bump type: $BUMP_TYPE"
    echo "Must be: major, minor, or patch"
    exit 1
fi

echo "Bumping version from $CURRENT_VERSION to $NEW_VERSION"

# Update package.json
pnpm version $NEW_VERSION --no-git-tag-version

# Update manifest.json
if command -v jq &> /dev/null; then
    jq --arg version "$NEW_VERSION" '.version = $version' src/manifest.json > src/manifest.json.tmp
    mv src/manifest.json.tmp src/manifest.json
    echo "✓ Updated src/manifest.json"
else
    # Fallback for macOS without jq
    sed -i '' "s/\"version\": \"$CURRENT_VERSION\"/\"version\": \"$NEW_VERSION\"/" src/manifest.json
    echo "✓ Updated src/manifest.json (using sed)"
fi

# Update dist/manifest.json if it exists
if [ -f "dist/manifest.json" ]; then
    if command -v jq &> /dev/null; then
        jq --arg version "$NEW_VERSION" '.version = $version' dist/manifest.json > dist/manifest.json.tmp
        mv dist/manifest.json.tmp dist/manifest.json
    else
        sed -i '' "s/\"version\": \"$CURRENT_VERSION\"/\"version\": \"$NEW_VERSION\"/" dist/manifest.json
    fi
    echo "✓ Updated dist/manifest.json"
fi

echo ""
echo "✅ Version bumped to $NEW_VERSION"
echo ""
echo "Next steps:"
echo "  1. Review changes: git diff"
echo "  2. Commit changes: git add -A && git commit -m 'chore: bump version to $NEW_VERSION'"
echo "  3. Create tag: git tag -a v$NEW_VERSION -m 'Release version $NEW_VERSION'"
echo "  4. Push: git push upstream main --tags"
echo ""
echo "Or use the quick release command:"
echo "  pnpm run release"
