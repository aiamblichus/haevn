#!/bin/bash

# Quick release script for HAEVN
# Commits version bump, creates tag, and pushes to trigger release workflow

set -e

if [ $# -eq 0 ]; then
    echo "Usage: $0 <major|minor|patch> [commit message]"
    echo "Example: $0 patch 'Fix sync issue with Claude'"
    exit 1
fi

BUMP_TYPE=$1
COMMIT_MSG="${2:-chore: release version bump}"

# Run version bump
./scripts/version-bump.sh $BUMP_TYPE

# Get new version
NEW_VERSION=$(node -p "require('./package.json').version")

echo ""
read -p "Create release v$NEW_VERSION? (y/n) " -n 1 -r
echo ""

if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Aborted."
    exit 1
fi

# Commit changes
git add package.json package-lock.json src/manifest.json
git commit -m "$COMMIT_MSG"

# Create tag
git tag -a v$NEW_VERSION -m "Release version $NEW_VERSION"

echo ""
echo "✅ Release v$NEW_VERSION prepared locally"
echo ""
read -p "Push to origin and trigger release? (y/n) " -n 1 -r
echo ""

if [[ $REPLY =~ ^[Yy]$ ]]; then
    git push origin main
    git push origin v$NEW_VERSION
    echo ""
    echo "🚀 Release v$NEW_VERSION pushed!"
    echo "Monitor the release at: https://github.com/YOUR_USERNAME/haevn/actions"
else
    echo ""
    echo "Release prepared but not pushed. To push manually:"
    echo "  git push origin main"
    echo "  git push origin v$NEW_VERSION"
fi
