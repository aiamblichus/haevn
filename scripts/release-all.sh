#!/bin/bash

# Combined release helper for extension + CLI
# Usage:
#   ./scripts/release-all.sh [extension_bump] [cli_bump] [commit message]
#
# Bump values: major | minor | patch | skip
# Examples:
#   ./scripts/release-all.sh patch patch
#   ./scripts/release-all.sh minor skip "chore(release): extension 1.2.0"

set -e

normalize_bump() {
  local value="$1"
  case "$value" in
    major|minor|patch|skip)
      echo "$value"
      ;;
    "")
      echo ""
      ;;
    *)
      echo "invalid"
      ;;
  esac
}

prompt_bump() {
  local label="$1"
  local value
  read -r -p "$label bump (major/minor/patch/skip) [patch]: " value
  value=${value:-patch}
  echo "$value"
}

EXT_BUMP=$(normalize_bump "$1")
CLI_BUMP=$(normalize_bump "$2")

if [ "$EXT_BUMP" = "invalid" ] || [ "$CLI_BUMP" = "invalid" ]; then
  echo "Invalid bump value. Allowed: major|minor|patch|skip"
  exit 1
fi

if [ -z "$EXT_BUMP" ]; then
  EXT_BUMP=$(prompt_bump "Extension")
  EXT_BUMP=$(normalize_bump "$EXT_BUMP")
fi

if [ -z "$CLI_BUMP" ]; then
  CLI_BUMP=$(prompt_bump "CLI")
  CLI_BUMP=$(normalize_bump "$CLI_BUMP")
fi

if [ "$EXT_BUMP" = "invalid" ] || [ "$CLI_BUMP" = "invalid" ]; then
  echo "Invalid bump value. Allowed: major|minor|patch|skip"
  exit 1
fi

if [ "$EXT_BUMP" = "skip" ] && [ "$CLI_BUMP" = "skip" ]; then
  echo "Nothing to release: both extension and CLI are set to skip."
  exit 1
fi

if [ "$EXT_BUMP" != "skip" ]; then
  ./scripts/version-bump.sh "$EXT_BUMP"
fi

if [ "$CLI_BUMP" != "skip" ]; then
  ./scripts/cli-version-bump.sh "$CLI_BUMP"
fi

EXT_VERSION=$(node -p "require('./package.json').version")
CLI_VERSION=$(node -p "require('./cli/package.json').version")

if [ "$EXT_BUMP" = "skip" ]; then
  EXT_LABEL="unchanged"
else
  EXT_LABEL="v$EXT_VERSION"
fi

if [ "$CLI_BUMP" = "skip" ]; then
  CLI_LABEL="unchanged"
else
  CLI_LABEL="cli-v$CLI_VERSION"
fi

DEFAULT_COMMIT_MSG="chore(release): extension ${EXT_LABEL}, cli ${CLI_LABEL}"
COMMIT_MSG="${3:-$DEFAULT_COMMIT_MSG}"

echo ""
echo "Release summary:"
echo "  Extension: $EXT_LABEL"
echo "  CLI:       $CLI_LABEL"
echo "  Commit:    $COMMIT_MSG"
echo ""
read -r -p "Create combined release commit + tags? (y/n) " -n 1 -r
echo ""

if [[ ! $REPLY =~ ^[Yy]$ ]]; then
  echo "Aborted."
  exit 1
fi

FILES_TO_ADD=()
if [ "$EXT_BUMP" != "skip" ]; then
  FILES_TO_ADD+=("package.json" "pnpm-lock.yaml" "src/manifest.json")
fi
if [ "$CLI_BUMP" != "skip" ]; then
  FILES_TO_ADD+=("cli/package.json" "cli/pnpm-lock.yaml")
fi

git add "${FILES_TO_ADD[@]}"
git commit -m "$COMMIT_MSG"

if [ "$EXT_BUMP" != "skip" ]; then
  git tag -a "v$EXT_VERSION" -m "Release version $EXT_VERSION"
fi
if [ "$CLI_BUMP" != "skip" ]; then
  git tag -a "cli-v$CLI_VERSION" -m "CLI release $CLI_VERSION"
fi

echo ""
echo "✅ Combined release prepared locally"
if [ "$EXT_BUMP" != "skip" ]; then
  echo "  - v$EXT_VERSION"
fi
if [ "$CLI_BUMP" != "skip" ]; then
  echo "  - cli-v$CLI_VERSION"
fi
echo ""
read -r -p "Push to upstream main and release tags now? (y/n) " -n 1 -r
echo ""

if [[ $REPLY =~ ^[Yy]$ ]]; then
  git push upstream main
  if [ "$EXT_BUMP" != "skip" ]; then
    git push upstream "v$EXT_VERSION"
  fi
  if [ "$CLI_BUMP" != "skip" ]; then
    git push upstream "cli-v$CLI_VERSION"
  fi
  echo ""
  echo "🚀 Release tags pushed. Monitor workflows:"
  echo "https://github.com/aiamblichus/haevn/actions"
else
  echo ""
  echo "Release prepared but not pushed. Push manually:"
  echo "  git push upstream main"
  if [ "$EXT_BUMP" != "skip" ]; then
    echo "  git push upstream v$EXT_VERSION"
  fi
  if [ "$CLI_BUMP" != "skip" ]; then
    echo "  git push upstream cli-v$CLI_VERSION"
  fi
fi
