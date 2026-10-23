#!/usr/bin/env sh
# Pickle Rick for opencode — installer / uninstaller.
set -eu

SRC="$(cd "$(dirname "$0")" && pwd)/.opencode"
DIRS="plugins pickle-rick commands agents skills"

usage() {
  cat <<'EOF'
Pickle Rick for opencode — installer

Usage:
  ./install.sh [PROJECT]              install into PROJECT/.opencode (default: current dir)
  ./install.sh --global               install into ~/.config/opencode (or $XDG_CONFIG_HOME/opencode)
  ./install.sh --uninstall [PROJECT]  remove the files this package installed
  ./install.sh --uninstall --global   remove the global install
  ./install.sh --help                 show this help

Uninstall only removes files this package owns; other plugins, agents and
commands are left untouched. Restart opencode afterwards.
EOF
}

MODE=install
GLOBAL=0
TARGET=""
for arg in "$@"; do
  case "$arg" in
    -h|--help) usage; exit 0 ;;
    --uninstall) MODE=uninstall ;;
    --global) GLOBAL=1 ;;
    -*) echo "install: unknown option: $arg" >&2; usage >&2; exit 1 ;;
    *) TARGET="$arg" ;;
  esac
done

[ -d "$SRC" ] || { echo "install: source not found: $SRC" >&2; exit 1; }
for d in $DIRS; do
  [ -d "$SRC/$d" ] || { echo "install: missing package directory: .opencode/$d" >&2; exit 1; }
done

if [ "$GLOBAL" = 1 ]; then
  PROJECT=""
  DEST="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
else
  PROJECT="${TARGET:-.}"
  [ -d "$PROJECT" ] || { echo "install: project directory does not exist: $PROJECT" >&2; exit 1; }
  DEST="$PROJECT/.opencode"
fi

if [ "$MODE" = uninstall ]; then
  [ -d "$DEST" ] || { echo "🥒 Nothing to remove: $DEST does not exist"; exit 0; }
  TMP="$(mktemp)"
  trap 'rm -f "$TMP"' EXIT
  for d in $DIRS; do
    ( cd "$SRC/$d" && find . -type f -print ) | while IFS= read -r rel; do
      rel="${rel#./}"
      if [ -f "$DEST/$d/$rel" ]; then
        rm -f "$DEST/$d/$rel"
        echo x >> "$TMP"
      fi
    done
    # Remove only the directories that became empty; rmdir refuses non-empty ones.
    [ -d "$DEST/$d" ] && find "$DEST/$d" -depth -type d -exec rmdir {} \; 2>/dev/null || true
  done
  COUNT="$(wc -l < "$TMP" | tr -d ' ')"
  echo "🥒 Pickle Rick removed from $DEST ($COUNT files) — restart opencode"
  exit 0
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
