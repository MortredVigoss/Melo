#!/bin/zsh
# Build with the already configured Xcode team. Does not install or launch.
set -euo pipefail
cd "${0:A:h}/../.."
python3 ios/scripts/build-scene.py
python3 ios/scripts/generate-project.py
xcodebuild -project ios/Melo.xcodeproj -scheme Melo -configuration Release \
  -destination 'generic/platform=iOS' -derivedDataPath ios/build-signed build
codesign --verify --deep --strict ios/build-signed/Build/Products/Release-iphoneos/Melo.app
python3 - <<'PY'
from pathlib import Path
import hashlib,json,plistlib,subprocess,tempfile
app=Path('ios/build-signed/Build/Products/Release-iphoneos/Melo.app')
info=plistlib.loads((app/'Info.plist').read_bytes()); version=info['CFBundleShortVersionString']
dest=Path('ios/dist')/f'Melo-{version}-personal-test.ipa'; dest.parent.mkdir(parents=True,exist_ok=True)
assert (app/'Scene/desktop-manifest.json').read_bytes()==Path('ios/Melo/Scene/desktop-manifest.json').read_bytes()
with tempfile.TemporaryDirectory(prefix='melo-personal-build-') as stage:
    payload=Path(stage)/'Payload'; payload.mkdir()
    subprocess.run(['ditto',str(app),str(payload/'Melo.app')],check=True)
    subprocess.run(['ditto','-c','-k','--keepParent',str(payload),str(dest)],check=True)
record={'version':version,'build':info['CFBundleVersion'],'bundle':info['CFBundleIdentifier'],'ipa':str(dest),'sha256':hashlib.sha256(dest.read_bytes()).hexdigest(),'installed':False}
(dest.parent/f'Melo-{version}-build.json').write_text(json.dumps(record,indent=2)+'\n')
print(json.dumps(record,indent=2))
PY
