#!/usr/bin/env bash
set -euo pipefail

staged_files=()
while IFS= read -r -d '' file; do
  case "$file" in
    src/*.ts|src/*.tsx|src/*.js|src/*.jsx|src/*.mjs|src/*.cjs|src/*.json|src/*.jsonc)
      staged_files+=("$file")
      ;;
  esac
done < <(git diff --cached --name-only --diff-filter=ACMR -z)

if [ ${#staged_files[@]} -eq 0 ]; then
  echo "pre-commit: no staged src files for Biome check"
  exit 0
fi

echo "pre-commit: running Biome check on staged files"
pnpm exec biome check "${staged_files[@]}"
