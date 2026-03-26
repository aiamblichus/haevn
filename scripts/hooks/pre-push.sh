#!/usr/bin/env bash
set -euo pipefail

echo "pre-push: running extension build"
pnpm run build

echo "pre-push: running docs build"
pnpm -C docs run build
