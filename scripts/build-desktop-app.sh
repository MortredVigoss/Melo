#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BUILD_DIR="$PROJECT_DIR/.tmp/desktop-build"
MODULE_CACHE_DIR="$PROJECT_DIR/.tmp/swift-module-cache"
# 2026-05-12 cleanup: APP_DIR used to live at "$PROJECT_DIR/Melo.app" — that
# put a third Melo.app right alongside the source tree, which Spotlight
# happily indexed as a separate app duplicate of the install-target copies.
# Moved into .tmp/desktop-build/ (alongside the Swift binary, already
# gitignored) so the source tree stays clean.  install-desktop-app.sh and
# verify-red-green.js were updated to read from the new location.
APP_DIR="$BUILD_DIR/Melo.app"
BIN_NAME="MeloDesktop"
ICON_NAME="melo.icns"

rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"
mkdir -p "$MODULE_CACHE_DIR"

swiftc \
  -parse-as-library \
  -module-cache-path "$MODULE_CACHE_DIR" \
  -framework Cocoa \
  -framework AVFoundation \
  -framework Speech \
  -framework WebKit \
  "$PROJECT_DIR/desktop-app/main.swift" \
  "$PROJECT_DIR/desktop-app/ProcessShutdown.swift" \
  "$PROJECT_DIR/ios/Melo/VoiceInput.swift" \
  "$PROJECT_DIR/ios/Melo/SystemSpeechInput.swift" \
  -o "$BUILD_DIR/$BIN_NAME"

rm -rf "$APP_DIR"
mkdir -p "$APP_DIR/Contents/MacOS" "$APP_DIR/Contents/Resources"

cp "$BUILD_DIR/$BIN_NAME" "$APP_DIR/Contents/MacOS/$BIN_NAME"
chmod +x "$APP_DIR/Contents/MacOS/$BIN_NAME"
cp "$PROJECT_DIR/assets/melo.icns" "$APP_DIR/Contents/Resources/$ICON_NAME"

cat > "$APP_DIR/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>CFBundleDevelopmentRegion</key>
    <string>en</string>
    <key>CFBundleDisplayName</key>
    <string>Melo</string>
    <key>CFBundleExecutable</key>
    <string>MeloDesktop</string>
    <key>CFBundleIconFile</key>
    <string>melo.icns</string>
    <key>CFBundleIdentifier</key>
    <string>com.melo.desktop</string>
    <key>CFBundleInfoDictionaryVersion</key>
    <string>6.0</string>
    <key>CFBundleName</key>
    <string>Melo</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleShortVersionString</key>
    <string>0.2.0</string>
    <key>CFBundleVersion</key>
    <string>1</string>
    <key>LSMinimumSystemVersion</key>
    <string>13.0</string>
    <key>NSHighResolutionCapable</key>
    <true/>
    <key>NSMicrophoneUsageDescription</key>
    <string>Melo uses the microphone when you choose voice input in the desktop composer.</string>
    <key>NSSpeechRecognitionUsageDescription</key>
    <string>Melo uses speech recognition to turn your voice into chat input.</string>
  </dict>
</plist>
PLIST

# swiftc signs the executable, but the assembled bundle also needs a resource seal.
# Sign after Info.plist and icons are present so local updates remain launchable.
# Model assets are part of Melo, never fetched by inference at runtime.
(cd "$PROJECT_DIR" && node scripts/prepare-memory-model.js)
mkdir -p "$APP_DIR/Contents/Resources/models"
cp "$PROJECT_DIR/assets/memory-model-NOTICE.txt" "$APP_DIR/Contents/Resources/models/NOTICE.txt"
ditto "$PROJECT_DIR/assets/models/multilingual-e5-small" "$APP_DIR/Contents/Resources/models/multilingual-e5-small"
node "$PROJECT_DIR/scripts/build-launch-screen.js" "$APP_DIR/Contents/Resources/Launch.html"
codesign --force --sign - "$APP_DIR"
codesign --verify --deep --strict "$APP_DIR"
