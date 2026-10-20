import test from 'node:test';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

test('iOS inventory is side-effect free, resource checks precede tests, and caller ownership avoids duplicate JS',()=>{
  execFileSync('python3',['-c',String.raw`
import sys, importlib.util, tempfile, hashlib, json
from pathlib import Path
sys.path.insert(0,sys.argv[1])
spec=importlib.util.spec_from_file_location('melo_gate',Path(sys.argv[1])/'test.py')
gate=importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)
commands=[]
gate.subprocess.run=lambda args,**kwargs: commands.append(args)
gate.subprocess.check_output=lambda *args,**kwargs: (_ for _ in ()).throw(AssertionError('inventory/renderer must not compile'))
sys.argv=['test.py','--list-suites'];gate.main();assert commands==[]
assert 'ios/Melo/DraftMerge.swift' in gate.suite_sources()['AgentEditTests']
with tempfile.TemporaryDirectory() as tmp:
    gate.root=Path(tmp)
    (gate.root/'ios/Melo/Scene').mkdir(parents=True)
    (gate.root/'input.css').write_text('ok')
    manifest=gate.root/'ios/Melo/Scene/desktop-manifest.json'
    manifest.write_text(json.dumps({'input.css':hashlib.sha256(b'ok').hexdigest()}))
    sys.argv=['test.py','--check-renderer'];gate.main();assert commands==[]
    sys.argv=['test.py','--renderer-only'];gate.main();assert len(commands)==1
    assert commands[0][1]=='--test'
    commands.clear()
    sys.argv=['test.py','--renderer-only','--skip-js'];gate.main();assert commands==[]
    (gate.root/'input.css').write_text('stale')
    sys.argv=['test.py','--renderer-only']
    try: gate.main();raise AssertionError('stale manifest accepted')
    except RuntimeError: pass
    assert commands==[], 'preflight must fail before JS'
`,fileURLToPath(new URL('../ios/scripts',import.meta.url))],{stdio:'pipe'});
});
