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
if [[ -z "$VAULT" ]]; then
  echo "error: no vault path given." >&2
  echo "usage: ./install.sh /path/to/your/vault" >&2
  exit 1
fi

if [[ ! -d "$VAULT/.obsidian" ]]; then
  echo "error: '$VAULT' does not look like an Obsidian vault (no .obsidian dir)." >&2
  exit 1
fi

# Build if the bundle is missing.
if [[ ! -f "$ROOT/main.js" ]]; then
  echo "main.js not found — building..."
  ( cd "$ROOT" && npm run build )
fi

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
