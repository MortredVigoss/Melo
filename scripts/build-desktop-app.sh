#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BUILD_DIR="$PROJECT_DIR/.tmp/desktop-build"
MODULE_CACHE_DIR="$PROJECT_DIR/.tmp/swift-module-cache"
APP_DIR="$PROJECT_DIR/Melo.app"
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
