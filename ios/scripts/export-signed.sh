#!/bin/zsh
set -euo pipefail
cd "${0:A:h}/.."
: "${MELO_APPLE_TEAM_ID:?Set MELO_APPLE_TEAM_ID to your paid Apple Developer team ID}"
python3 scripts/build-scene.py
python3 scripts/generate-project.py
# Add the Apple account in Xcode and register the iPhone first.
xcodebuild -project Melo.xcodeproj -scheme Melo -configuration Release -destination 'generic/platform=iOS' \
  -archivePath "$PWD/build/Melo.xcarchive" DEVELOPMENT_TEAM="$MELO_APPLE_TEAM_ID" -allowProvisioningUpdates archive
mkdir -p build dist
python3 - <<'PY'
import os, plistlib
with open('build/ExportOptions.plist','wb') as f:
    plistlib.dump({'method':'release-testing','teamID':os.environ['MELO_APPLE_TEAM_ID'],'signingStyle':'automatic','stripSwiftSymbols':True},f)
PY
xcodebuild -exportArchive -archivePath "$PWD/build/Melo.xcarchive" \
  -exportOptionsPlist "$PWD/build/ExportOptions.plist" -exportPath "$PWD/dist/signed" -allowProvisioningUpdates
