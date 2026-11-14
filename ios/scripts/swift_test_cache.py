"""Cache compilation, never test execution. Content + toolchain addressed."""
from pathlib import Path
import hashlib
import json
import os
import shutil
import subprocess
import tempfile
import time

# Binaries kept per suite: the current inputs and the few before them. Every
# source edit makes a new one; without a limit the cache reached 4.8 GB in ten
# days (2026-11-14) while one set of current binaries is about 110 MB.
KEEP = 4
RECENT_SECONDS = 3600


def prune_suite(directory, keep=KEEP, now=None, recent=RECENT_SECONDS):
    """Remove all but the `keep` most recently used binaries of one suite.

    Anything used within the last hour stays whatever the count, so two runs
    working on different inputs never delete each other's binaries."""
    now = time.time() if now is None else now
    entries = sorted((entry for entry in Path(directory).iterdir() if entry.is_dir()),
                     key=lambda entry: entry.stat().st_mtime, reverse=True)
    removed = []
    for entry in entries[keep:]:
        if now - entry.stat().st_mtime < recent:
            continue
        shutil.rmtree(entry, ignore_errors=True)
        removed.append(entry.name)
    return removed


def prepare_suite(root, cache, name, sources, toolchain, compiler, run=subprocess.run):
    """Compile one suite unless an intact binary for exactly these inputs exists.

    Returns (binary, hit). Safe to call for several suites at once: each one
    compiles in its own temporary directory beside its own destination."""
    root, cache = Path(root), Path(cache)
    digest = hashlib.sha256(json.dumps({'version': 1, 'toolchain': toolchain,
                                       'compiler': compiler}, sort_keys=True).encode())
    for source in sources:
        content = (root / source).read_bytes()
        digest.update(json.dumps([source, len(content)]).encode())
        digest.update(content)
    directory = cache / name / digest.hexdigest()
    binary, receipt = directory / 'suite', directory / 'sha256'
    hit = binary.is_file() and os.access(binary, os.X_OK) and receipt.is_file()
    if hit:
        hit = hashlib.sha256(binary.read_bytes()).hexdigest() == receipt.read_text()
    if hit:
        os.utime(directory)  # last use, read by prune_suite
    if not hit:
        directory.mkdir(parents=True, exist_ok=True)
        # Compile beside the destination; a failed/parallel build never publishes
        # a partial executable. Hash the published binary before every reuse.
        with tempfile.TemporaryDirectory(prefix='compile-', dir=directory) as work:
            output = Path(work) / 'suite'
            run([*compiler, *sources, '-o', str(output)], cwd=root, check=True)
            stamp = Path(work) / 'sha256'
            stamp.write_text(hashlib.sha256(output.read_bytes()).hexdigest())
            os.replace(output, binary)
            os.replace(stamp, receipt)
        os.utime(directory)
        prune_suite(cache / name)
    return binary, hit


def cached_suite(root, cache, name, sources, toolchain, compiler, run=subprocess.run):
    binary, hit = prepare_suite(root, cache, name, sources, toolchain, compiler, run)
    print(f'{name}: {"cached compile" if hit else "compiled"}; running tests', flush=True)
    run([str(binary)], cwd=root, check=True)
    return hit
