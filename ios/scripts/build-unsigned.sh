#!/bin/zsh
set -euo pipefail
cd "${0:A:h}/.."
python3 scripts/build-scene.py
python3 scripts/generate-project.py
xcodebuild -project Melo.xcodeproj -target Melo -configuration Release -sdk iphoneos \
  SYMROOT="$PWD/build/Products" OBJROOT="$PWD/build/Intermediates" CODE_SIGNING_ALLOWED=NO build
mkdir -p dist
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
mkdir -p "$stage/Payload"
ditto build/Products/Release-iphoneos/Melo.app "$stage/Payload/Melo.app"
ditto -c -k --keepParent "$stage/Payload" dist/Melo-unsigned.ipa
printf '%s\n' 'Created dist/Melo-unsigned.ipa. Not installable until signed with your Apple development/distribution credentials.'
