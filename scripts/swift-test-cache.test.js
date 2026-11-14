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

// 2026-11-14: the gate compiles several suites at once and runs them afterwards.
// The compile half must not execute anything, must be safe for several suites
// at the same time, and must leave the cache exactly as the one-step form does.
test('compiling ahead never runs a suite, works for several suites at once, and feeds the same cache', () => {
  execFileSync('python3', ['-c', String.raw`
import sys, tempfile, subprocess, threading, time, concurrent.futures
from pathlib import Path
sys.path.insert(0, sys.argv[1])
from swift_test_cache import prepare_suite, cached_suite
with tempfile.TemporaryDirectory() as tmp:
    root = Path(tmp)
    for name in 'abc': (root/(name+'.swift')).write_text(name)
    lock = threading.Lock()
    state = {'compile':0, 'execute':0, 'together':0, 'peak':0}
    def run(args, **kwargs):
        if args[0] == 'compiler':
            with lock:
                state['compile'] += 1; state['together'] += 1; state['peak'] = max(state['peak'], state['together'])
            time.sleep(0.15)
            output = Path(args[-1]); output.write_text('built from ' + ' '.join(args[1:-2])); output.chmod(0o755)
            with lock: state['together'] -= 1
        else:
            with lock: state['execute'] += 1
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        results = list(pool.map(lambda name: prepare_suite(root, root/'cache', name, [name+'.swift'], 'v1', ['compiler'], run), 'abc'))
    assert state['compile'] == 3 and state['execute'] == 0, state
    assert state['peak'] > 1, 'the suites were compiled one after another'
    assert [hit for _, hit in results] == [False, False, False]
    binaries = [binary for binary, _ in results]
    assert len(set(binaries)) == 3 and all(binary.read_text().startswith('built from') for binary in binaries)
    assert not list((root/'cache').rglob('compile-*')), 'a temporary build directory was left behind'
    # The one-step form finds what the compile half built and only runs it.
    assert cached_suite(root, root/'cache', 'a', ['a.swift'], 'v1', ['compiler'], run) is True
    assert state == {'compile':3, 'execute':1, 'together':0, 'peak':state['peak']}, state
    # A failed compilation raises and publishes nothing.
    def broken(args, **kwargs): raise subprocess.CalledProcessError(1, args, output='error: fixture')
    try: prepare_suite(root, root/'cache', 'd', ['a.swift'], 'v2', ['compiler'], broken); raise AssertionError('compile failure swallowed')
    except subprocess.CalledProcessError: pass
    assert not list((root/'cache'/'d').rglob('suite'))
`, fileURLToPath(new URL('../ios/scripts', import.meta.url))], {stdio:'pipe'});
});

// 2026-11-14: every source edit adds a binary and nothing removed the old ones
// (4.8 GB after ten days). Only the binaries last used are kept; one used
// within the hour is never removed, and a kept binary is still a cache hit.
test('old binaries of a suite are pruned by last use; recent ones and the current one stay', () => {
  execFileSync('python3', ['-c', String.raw`
import os, sys, tempfile, time
from pathlib import Path
sys.path.insert(0, sys.argv[1])
from swift_test_cache import prepare_suite, prune_suite, KEEP
with tempfile.TemporaryDirectory() as tmp:
    root = Path(tmp); source = root/'a.swift'
    compiled = []
    def run(args, **kwargs):
        compiled.append(args)
        output = Path(args[-1]); output.write_text('fixture'); output.chmod(0o755)
    def build(text):
        source.write_text(text)
        return prepare_suite(root, root/'cache', 'demo', ['a.swift'], 'v1', ['compiler'], run)
    old = time.time() - 7200
    binaries = []
    for index in range(KEEP + 3):
        binary, hit = build('version %d' % index); assert hit is False
        binaries.append(binary)
        os.utime(binary.parent, (old + index, old + index))   # used two hours ago, in this order
    current, hit = build('current'); assert hit is False        # publishing a new binary prunes
    kept = sorted(entry.name for entry in (root/'cache'/'demo').iterdir())
    assert len(kept) == KEEP, kept
    assert current.is_file() and current.parent.name in kept
    assert [binary.parent.name in kept for binary in binaries] == [False] * 4 + [True] * (KEEP - 1), 'the most recently used stay'
    count = len(compiled)
    assert build('version %d' % (KEEP + 2))[1] is True and len(compiled) == count, 'a kept binary is still a hit'
    assert build('version 0')[1] is False, 'a pruned one is compiled again'
    # Used within the hour: never removed, whatever the count.
    fresh = root/'cache'/'fresh'
    for index in range(KEEP + 5): (fresh/str(index)).mkdir(parents=True)
    assert prune_suite(fresh) == [] and len(list(fresh.iterdir())) == KEEP + 5
    assert len(prune_suite(fresh, now=time.time() + 7200)) == 5
`, fileURLToPath(new URL('../ios/scripts', import.meta.url))], {stdio:'pipe'});
});
