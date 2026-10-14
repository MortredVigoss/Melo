#!/usr/bin/env python3
"""Offline signature, ZIP and ELF alignment checks; no credentials or device needed."""
import argparse
import os
import pathlib
import struct
import subprocess
import zipfile

parser = argparse.ArgumentParser()
parser.add_argument('apk', type=pathlib.Path)
parser.add_argument('--sdk', type=pathlib.Path, default=os.environ.get('ANDROID_HOME') or os.environ.get('ANDROID_SDK_ROOT'))
parser.add_argument('--unsigned', action='store_true', help='Only for an intentionally unsigned release artifact')
args = parser.parse_args()
if not args.sdk:
    parser.error('Set ANDROID_HOME or --sdk')
tools = args.sdk / 'build-tools' / '36.0.0'
subprocess.run([str(tools / 'zipalign'), '-c', '-P', '16', '4', str(args.apk)], check=True)
if not args.unsigned:
    subprocess.run([str(tools / 'apksigner'), 'verify', '--verbose', str(args.apk)], check=True)
count = 0
with zipfile.ZipFile(args.apk) as archive:
    for name in archive.namelist():
        if not name.startswith('lib/') or not name.endswith('.so'):
            continue
        data = archive.read(name)
        if data[:4] != b'\x7fELF':
            raise ValueError(f'Invalid ELF: {name}')
        endian = '<' if data[5] == 1 else '>'
        if data[4] == 2:
            offset = struct.unpack_from(endian + 'Q', data, 32)[0]
            entry_size, entries = struct.unpack_from(endian + 'HH', data, 54)
            alignment_offset, alignment_format = 48, 'Q'
        else:
            offset = struct.unpack_from(endian + 'I', data, 28)[0]
            entry_size, entries = struct.unpack_from(endian + 'HH', data, 42)
            alignment_offset, alignment_format = 28, 'I'
        alignments = [struct.unpack_from(endian + alignment_format, data, offset + i * entry_size + alignment_offset)[0]
                      for i in range(entries) if struct.unpack_from(endian + 'I', data, offset + i * entry_size)[0] == 1]
        if not alignments or min(alignments) < 16384:
            raise ValueError(f'ELF LOAD alignment below 16 KiB: {name}: {alignments}')
        count += 1
        print(f'16 KiB ELF: {name}')
print(f'APK alignment verified; {count} native libraries checked. Signature {"intentionally not checked (unsigned)" if args.unsigned else "verified"}.')
