#!/bin/bash

# Quick release script for HAEVN CLI
# Bumps cli/package.json, commits, tags, and pushes to trigger CLI publish workflow

set -e

if [ $# -eq 0 ]; then
  echo "Usage: $0 <major|minor|patch> [commit message]"
  echo "Example: $0 patch 'chore(cli): release 0.1.1'"
  exit 1
fi

BUMP_TYPE=$1

./scripts/cli-version-bump.sh "$BUMP_TYPE"

NEW_VERSION=$(node -p "require('./cli/package.json').version")
DEFAULT_COMMIT_MSG="chore(cli): release $NEW_VERSION"
COMMIT_MSG="${2:-$DEFAULT_COMMIT_MSG}"

echo ""
read -p "Create CLI release cli-v$NEW_VERSION? (y/n) " -n 1 -r
echo ""

if [[ ! $REPLY =~ ^[Yy]$ ]]; then
  echo "Aborted."
  exit 1
fi

git add cli/package.json cli/pnpm-lock.yaml
git commit -m "$COMMIT_MSG"
git tag -a "cli-v$NEW_VERSION" -m "CLI release $NEW_VERSION"

echo ""
echo "✅ CLI release cli-v$NEW_VERSION prepared locally"
echo ""
read -p "Push to upstream and trigger npm publish workflow? (y/n) " -n 1 -r
echo ""

if [[ $REPLY =~ ^[Yy]$ ]]; then
  git push upstream main
  git push upstream "cli-v$NEW_VERSION"
  echo ""
  echo "🚀 CLI release cli-v$NEW_VERSION pushed!"
  echo "Monitor workflow at: https://github.com/aiamblichus/haevn/actions"
else
  echo ""
  echo "CLI release prepared but not pushed. To push manually:"
  echo "  git push upstream main"
  echo "  git push upstream cli-v$NEW_VERSION"
fi
