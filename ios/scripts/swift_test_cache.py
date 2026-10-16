"""Cache compilation, never test execution. Content + toolchain addressed."""
from pathlib import Path
import hashlib
import json
import os
import subprocess
import tempfile


def cached_suite(root, cache, name, sources, toolchain, compiler, run=subprocess.run):
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
    print(f'{name}: {"cached compile" if hit else "compiled"}; running tests', flush=True)
    run([str(binary)], cwd=root, check=True)
    return hit
