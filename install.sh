#!/usr/bin/env bash
# Install the built GemmaNotes plugin into an Obsidian vault for local testing.
#
# Usage:
#   ./install.sh /path/to/your/vault
#   OBSIDIAN_VAULT=/path/to/vault ./install.sh
#
# Builds the plugin if main.js is missing, then copies the plugin files into
# <vault>/.obsidian/plugins/gemmanotes/.

set -euo pipefail

PLUGIN_ID="gemmanotes"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

VAULT="${1:-${OBSIDIAN_VAULT:-}}"
BRANCH="${2:-${FEATURE_BRANCH:-main}}"
if [[ -z "$VAULT" ]]; then
  echo "error: no vault path given." >&2
  echo "usage: ./install.sh /path/to/your/vault [feature-branch]" >&2
  exit 1
fi

if [[ ! -d "$VAULT/.obsidian" ]]; then
  echo "error: '$VAULT' does not look like an Obsidian vault (no .obsidian dir)." >&2
  exit 1
fi

if ! git -C "$ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "error: repository root not found at '$ROOT'." >&2
  exit 1
fi

function restore_stash {
  if [[ "${STASHED:-0}" == "1" ]]; then
    echo "Restoring stashed changes..."
    git -C "$ROOT" stash pop --index >/dev/null 2>&1 || true
  fi
}
trap restore_stash EXIT

echo "Fetching origin..."
git -C "$ROOT" fetch origin --prune

if ! git -C "$ROOT" show-ref --verify --quiet "refs/remotes/origin/$BRANCH"; then
  echo "error: origin/$BRANCH does not exist." >&2
  exit 1
fi

if [[ -n "$(git -C "$ROOT" status --porcelain)" ]]; then
  echo "Stashing local changes..."
  git -C "$ROOT" stash push -u -m "install.sh auto-stash" >/dev/null
  STASHED=1
fi

if git -C "$ROOT" show-ref --verify --quiet "refs/heads/$BRANCH"; then
  echo "Resetting local branch '$BRANCH' to origin/$BRANCH..."
  git -C "$ROOT" checkout -q "$BRANCH"
  git -C "$ROOT" reset --hard "origin/$BRANCH"
else
  echo "Checking out local branch '$BRANCH' from origin/$BRANCH..."
  git -C "$ROOT" checkout -q -b "$BRANCH" "origin/$BRANCH"
  git -C "$ROOT" branch --set-upstream-to="origin/$BRANCH" "$BRANCH" >/dev/null
fi

echo "Running build..."
( cd "$ROOT" && npm run build )

DEST="$VAULT/.obsidian/plugins/$PLUGIN_ID"
mkdir -p "$DEST"

for f in main.js manifest.json styles.css; do
  if [[ ! -f "$ROOT/$f" ]]; then
    echo "error: $f missing — run 'npm run build' first." >&2
    exit 1
  fi
  cp "$ROOT/$f" "$DEST/$f"
  echo "  copied $f"
done

echo "Installed GemmaNotes to: $DEST"
echo "Reload Obsidian (or toggle the plugin) to pick up the changes."
