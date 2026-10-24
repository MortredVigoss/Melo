#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
APP_DIR="$(node "$SCRIPT_DIR/desktop-install-paths.js" "$PROJECT_DIR" source)"
PRIMARY_DEPLOY_TARGET="$(node "$SCRIPT_DIR/desktop-install-paths.js" "$PROJECT_DIR" primary)"
DESKTOP_FOLDER_APP_TARGET="$(node "$SCRIPT_DIR/desktop-install-paths.js" "$PROJECT_DIR" shortcut)"

verify_bundle() {
  local bundle="$1"
  [[ -d "$bundle" && ! -L "$bundle" ]] || return 1
  local identifier="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$bundle/Contents/Info.plist" 2>/dev/null)"
  local executable="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$bundle/Contents/Info.plist" 2>/dev/null)"
  [[ "$identifier" == "com.melo.desktop" && "$executable" != */* && -x "$bundle/Contents/MacOS/$executable" ]]
}

if ! verify_bundle "$APP_DIR"; then
  echo "Valid built Melo app not found at $APP_DIR. Run npm run build:desktop first." >&2
  exit 1
fi
for target in "$PRIMARY_DEPLOY_TARGET" "$DESKTOP_FOLDER_APP_TARGET"; do
  if [[ -e "$target" && ! -L "$target" ]] && ! verify_bundle "$target"; then
    echo "Refusing to replace an unrelated file or app: $target" >&2
    exit 1
  fi
done

# Stage a complete bundle before moving the existing app. User data lives
# outside the bundle; no account/container/data-directory cleanup runs here.
mkdir -p "$(dirname "$PRIMARY_DEPLOY_TARGET")"
STAGING_DIR="$(mktemp -d "$(dirname "$PRIMARY_DEPLOY_TARGET")/.melo-install.XXXXXX")"
trap 'rm -rf "$STAGING_DIR"' EXIT
ditto "$APP_DIR" "$STAGING_DIR/Melo.app"
verify_bundle "$STAGING_DIR/Melo.app"
if [[ -e "$PRIMARY_DEPLOY_TARGET" || -L "$PRIMARY_DEPLOY_TARGET" ]]; then
  mv "$PRIMARY_DEPLOY_TARGET" "$STAGING_DIR/Previous.app"
fi
if ! mv "$STAGING_DIR/Melo.app" "$PRIMARY_DEPLOY_TARGET"; then
  [[ ! -e "$STAGING_DIR/Previous.app" ]] || mv "$STAGING_DIR/Previous.app" "$PRIMARY_DEPLOY_TARGET"
  exit 1
fi

if [[ "$DESKTOP_FOLDER_APP_TARGET" != "$PRIMARY_DEPLOY_TARGET" ]]; then
  mkdir -p "$(dirname "$DESKTOP_FOLDER_APP_TARGET")"
  if [[ -e "$DESKTOP_FOLDER_APP_TARGET" || -L "$DESKTOP_FOLDER_APP_TARGET" ]]; then
    rm -rf "$DESKTOP_FOLDER_APP_TARGET"
  fi
  ln -s "$PRIMARY_DEPLOY_TARGET" "$DESKTOP_FOLDER_APP_TARGET"
fi
