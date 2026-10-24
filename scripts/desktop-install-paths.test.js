import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, cp, readlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { desktopInstallPaths } from './desktop-install-paths.js';

test('install and release verification resolve relocated projects without personal directories', () => {
  assert.deepEqual(desktopInstallPaths({ projectDir:'/work/clone',home:'/users/test' }), {
    source:'/work/clone/.tmp/desktop-build/Melo.app',primary:'/users/test/Applications/Melo.app',shortcut:'/work/Melo.app'
  });
  const override=desktopInstallPaths({projectDir:'/work/clone',home:'/users/test',env:{MELO_DESKTOP_INSTALL_DIR:'/custom/apps',MELO_DESKTOP_SHORTCUT_DIR:'/custom/shortcuts'}});
  assert.equal(override.primary,'/custom/apps/Melo.app');
  assert.equal(override.shortcut,'/custom/shortcuts/Melo.app');
  assert.throws(()=>desktopInstallPaths({projectDir:'/work/clone',env:{MELO_DESKTOP_INSTALL_DIR:'/work/clone/.tmp/desktop-build'}}),/build source/);
  assert.throws(()=>desktopInstallPaths({projectDir:'relative'}),/absolute/);
});
test('overlay installation stages safely, preserves data and rejects unrelated targets', {skip:process.platform!=='darwin'}, async t=>{
  const root=await mkdtemp(join(tmpdir(),'melo-install-test-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const project=join(root,'checkout'),home=join(root,'user'),scripts=join(project,'scripts');
  await mkdir(scripts,{recursive:true});await mkdir(home,{recursive:true});
  for(const file of ['install-desktop-app.sh','desktop-install-paths.js']) await cp(new URL(file,import.meta.url),join(scripts,file));
  await writeFile(join(project,'package.json'),'{"type":"module"}');
  const paths=desktopInstallPaths({projectDir:project,home});
  await mkdir(join(paths.source,'Contents','MacOS'),{recursive:true});
  await writeFile(join(paths.source,'Contents','Info.plist'),'<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.melo.desktop</string><key>CFBundleExecutable</key><string>Melo</string></dict></plist>');
  await writeFile(join(paths.source,'Contents','MacOS','Melo'),'#!/bin/sh\nexit 0\n',{mode:0o755});
  const preserved=join(home,'existing-account-data');await writeFile(preserved,'preserve-exactly');
  const run=()=>spawnSync('/bin/zsh',[join(scripts,'install-desktop-app.sh')],{env:{...process.env,HOME:home,MELO_DESKTOP_INSTALL_DIR:join(home,'Applications'),MELO_DESKTOP_SHORTCUT_DIR:root},encoding:'utf8'});
  let result=run();assert.equal(result.status,0,result.stderr);
  assert.equal(await readlink(paths.shortcut),paths.primary);
  await writeFile(join(paths.source,'Contents','revision'),'next');
  result=run();assert.equal(result.status,0,result.stderr);
  assert.equal(await readFile(join(paths.primary,'Contents','revision'),'utf8'),'next');
  assert.equal(await readFile(preserved,'utf8'),'preserve-exactly');
  await rm(paths.shortcut);await writeFile(paths.shortcut,'not-an-app');
  result=run();assert.notEqual(result.status,0);assert.match(result.stderr,/unrelated/);
  assert.equal(await readFile(paths.shortcut,'utf8'),'not-an-app');
});
