#!/usr/bin/env sh
# Pickle Rick for opencode — installer.
set -eu

SRC="$(cd "$(dirname "$0")" && pwd)/.opencode"
DIRS="plugins pickle-rick commands agents skills"

usage() {
  cat <<'EOF'
Pickle Rick for opencode — installer

Usage:
  ./install.sh [PROJECT]   install into PROJECT/.opencode (default: current dir)
  ./install.sh --global    install into ~/.config/opencode (or $XDG_CONFIG_HOME/opencode)
  ./install.sh --help      show this help

Restart opencode afterwards, then run /help-pickle.
EOF
}

case "${1:-}" in
  -h|--help) usage; exit 0 ;;
esac

[ -d "$SRC" ] || { echo "install: source not found: $SRC" >&2; exit 1; }
for d in $DIRS; do
  [ -d "$SRC/$d" ] || { echo "install: missing package directory: .opencode/$d" >&2; exit 1; }
done

if [ "${1:-}" = "--global" ]; then
  PROJECT=""
  DEST="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
else
  PROJECT="${1:-.}"
  [ -d "$PROJECT" ] || { echo "install: project directory does not exist: $PROJECT" >&2; exit 1; }
  DEST="$PROJECT/.opencode"
fi

COUNT=0
for d in $DIRS; do
  mkdir -p "$DEST/$d"
  cp -R "$SRC/$d/." "$DEST/$d/"
  COUNT=$((COUNT + $(find "$SRC/$d" -type f | wc -l)))
done

if [ -n "$PROJECT" ]; then
  GI="$PROJECT/.gitignore"
  grep -qxF ".pickle-rick/" "$GI" 2>/dev/null || echo ".pickle-rick/" >> "$GI"
fi

echo "🥒 Pickle Rick installed in $DEST ($COUNT files) — restart opencode and run /help-pickle"
