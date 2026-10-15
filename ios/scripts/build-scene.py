#!/usr/bin/env python3
"""Bundle the desktop renderer unchanged, with only its import path relocated."""
from pathlib import Path
import hashlib,json,shutil,subprocess
root=Path(__file__).resolve().parents[2]
subprocess.run(['python3', str(root/'ios/scripts/sync-theme.py')], check=True)
work=root/'.tmp/ios-scene-src'; work.mkdir(parents=True,exist_ok=True)
out=root/'ios/Melo/Scene';out.mkdir(parents=True,exist_ok=True)
paths=['desktop-ui/i18n.js','desktop-ui/translations.js','desktop-ui/neuralScene3D.js','desktop-ui/neuralScene.js','desktop-ui/neuralSatellite.js','desktop-ui/executionDetails.js','desktop-ui/executionPanel.js','desktop-ui/executionScene3D.js','desktop-ui/executionViewport.js','desktop-ui/executionPicking.js','desktop-ui/synapticBody.js','desktop-ui/executionPanel.css','desktop-ui/neuralGlass.css','src/shared/executionScene.js']
manifest={}
for name in paths:
    path=root/name; content=path.read_text(); manifest[name]=hashlib.sha256(path.read_bytes()).hexdigest()
    dest=work/name;dest.parent.mkdir(parents=True,exist_ok=True)
    dest.write_text(content.replace("'/shared/executionScene.js'","'../src/shared/executionScene.js'"))
shutil.copy(root/'ios/SceneSource/mobile.js',work/'mobile.js')
for name in ['neural.js', 'neuralLayout.js']:
    shutil.copy(root/'ios/SceneSource'/name, work/name)
for name in ['ios/SceneSource/neural.js','ios/SceneSource/neuralLayout.js','ios/SceneSource/neural.css','ios/SceneSource/mobile.js','ios/SceneSource/mobile.css','ios/scripts/build-scene.py','ios/scripts/sync-theme.py','ios/Melo/MeloTheme.swift','node_modules/three/package.json']:
    manifest[name]=hashlib.sha256((root/name).read_bytes()).hexdigest()
subprocess.run(['npm','exec','--yes','--package=esbuild@0.25.12','--','esbuild',str(work/'mobile.js'),'--bundle','--format=iife','--target=safari17','--minify','--outfile='+str(out/'scene.js')],cwd=root,check=True)
subprocess.run(['npm','exec','--yes','--package=esbuild@0.25.12','--','esbuild',str(work/'neural.js'),'--bundle','--format=iife','--target=safari17','--minify','--outfile='+str(out/'neural.js')],cwd=root,check=True)
shutil.copy(root/'ios/SceneSource/neural.css',out/'neural.css')
(out/'neural.html').write_text('''<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'none'"><link rel="stylesheet" href="neural.css"></head><body><div id="neural"></div><script src="neural.js"></script></body></html>''')
(out/'scene.css').write_text('\n'.join((root/name).read_text() for name in ['desktop-ui/executionPanel.css','desktop-ui/neuralGlass.css','ios/SceneSource/mobile.css']))
(out/'index.html').write_text('''<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src data:; connect-src 'none'"><link rel="stylesheet" href="scene.css"></head><body><div id="app"></div><script src="scene.js"></script></body></html>''')
extractor=root/'src/memory/offline/extractor.js'
(out/'memory-extractor.js').write_text(extractor.read_text().replace('export function extractFactsRuleBased', 'function extractFactsRuleBased'))
manifest['src/memory/offline/extractor.js']=hashlib.sha256(extractor.read_bytes()).hexdigest()
(out/'desktop-manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
shutil.copy(root/'node_modules/three/LICENSE',out/'THREE-LICENSE.txt')
print('Bundled desktop neural and execution renderers with provenance manifest')
