import test from 'node:test';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

test('Swift cache skips only compilation; source/toolchain/corruption invalidate it, failures remain failures', () => {
  execFileSync('python3', ['-c', String.raw`
import sys, tempfile, subprocess
from pathlib import Path
sys.path.insert(0, sys.argv[1])
from swift_test_cache import cached_suite
with tempfile.TemporaryDirectory() as tmp:
    root = Path(tmp)
    (root/'a.swift').write_text('first')
    counts = {'compile':0, 'execute':0}
    fail_compile, fail_test = False, False
    def run(args, **kwargs):
        if args[0] == 'compiler':
            counts['compile'] += 1
            if fail_compile: raise subprocess.CalledProcessError(1,args)
            output = Path(args[-1]); output.write_text('fixture'); output.chmod(0o755)
        else:
            counts['execute'] += 1
            if fail_test: raise subprocess.CalledProcessError(1,args)
    def suite(version='v1'):
        return cached_suite(root,root/'cache','demo',['a.swift'],version,['compiler'],run)
    assert suite() is False
    assert suite() is True
    assert counts == {'compile':1,'execute':2}, counts
    (root/'a.swift').write_text('second')
    assert suite() is False
    assert suite('v2') is False
    for binary in (root/'cache').rglob('suite'): binary.write_text('corrupted')
    assert suite('v2') is False
    fail_test = True
    try: suite('v2'); raise AssertionError('test failure swallowed')
    except subprocess.CalledProcessError: pass
    assert counts == {'compile':4,'execute':6}, counts
    fail_test, fail_compile = False, True
    for _ in range(2):
        try: suite('new compiler'); raise AssertionError('compile failure swallowed')
        except subprocess.CalledProcessError: pass
    assert counts == {'compile':6,'execute':6}, counts
`, fileURLToPath(new URL('../ios/scripts', import.meta.url))], {stdio:'pipe'});
});
