#!/usr/bin/env sh
# Usage:
#   ./install.sh /path/to/project   # project-local install (default: current dir)
#   ./install.sh --global           # install into ~/.config/opencode
set -e
SRC="$(cd "$(dirname "$0")/.opencode" && pwd)"
if [ "$1" = "--global" ]; then
  DEST="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
else
  PROJECT="${1:-.}"
  DEST="$PROJECT/.opencode"
fi
for d in plugins pickle-rick commands agents skills; do
  mkdir -p "$DEST/$d"
  cp -R "$SRC/$d/." "$DEST/$d/"
done
if [ "$1" != "--global" ]; then
  GI="$PROJECT/.gitignore"
  grep -qxF ".pickle-rick/" "$GI" 2>/dev/null || echo ".pickle-rick/" >> "$GI"
fi
echo "🥒 Pickle Rick installed in $DEST — restart opencode and run /help-pickle"
