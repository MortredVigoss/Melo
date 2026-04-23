#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
APP_DIR="$PROJECT_DIR/Melo.app"
PRIMARY_DEPLOY_TARGET="$HOME/Applications/Melo.app"
DESKTOP_FOLDER_APP_TARGET="$HOME/Desktop/melo/Melo.app"
DESKTOP_APPLICATIONS_TARGET="$HOME/Desktop/melo/Applications/Melo.app"

if [[ ! -d "$APP_DIR" ]]; then
  echo "Built app not found at $APP_DIR. Run npm run build:desktop first." >&2
  exit 1
fi

mkdir -p "$(dirname "$PRIMARY_DEPLOY_TARGET")"
rm -rf "$PRIMARY_DEPLOY_TARGET"
ditto "$APP_DIR" "$PRIMARY_DEPLOY_TARGET"

mkdir -p "$(dirname "$DESKTOP_APPLICATIONS_TARGET")"
rm -rf "$DESKTOP_APPLICATIONS_TARGET"
ditto "$PRIMARY_DEPLOY_TARGET" "$DESKTOP_APPLICATIONS_TARGET"

mkdir -p "$(dirname "$DESKTOP_FOLDER_APP_TARGET")"
rm -rf "$DESKTOP_FOLDER_APP_TARGET"
ln -s "$PRIMARY_DEPLOY_TARGET" "$DESKTOP_FOLDER_APP_TARGET"
