#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Build a private-data-free Windows x64 portable package with verified local weights."""
import argparse
import hashlib
import json
import shutil
import struct
import zipfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]

def digest(file):
    h = hashlib.sha256()
    with file.open('rb') as stream:
        for block in iter(lambda: stream.read(8 * 1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()

def require_x64(file):
    with file.open('rb') as stream:
        assert stream.read(2) == b'MZ', f'Not PE: {file}'
        stream.seek(0x3c)
        offset = struct.unpack('<I', stream.read(4))[0]
        stream.seek(offset)
        assert stream.read(4) == b'PE\0\0', f'Invalid PE: {file}'
        assert struct.unpack('<H', stream.read(2))[0] == 0x8664, f'Not Windows x64: {file}'

def build(destination):
    destination = destination.resolve()
    assert not destination.is_relative_to(REPO), 'Output must be outside the source project'
    assert not destination.exists(), 'Use a new output directory'
    archive = destination.with_suffix('.zip')
    assert not archive.exists(), 'Archive already exists'
    require_x64(REPO / 'runtime/node/win32-x64/node.exe')
    require_x64(REPO / 'runtime/ollama/win32-x64/ollama.exe')
    expected = json.loads((REPO / 'models/MODEL_FILES.json').read_text())
    for item in expected:
        file = REPO / item['file']
        assert file.stat().st_size == item['bytes'] and digest(file) == item['sha256'], f'Model mismatch: {file}'
    destination.mkdir(parents=True)
    def copy(relative):
        source = REPO / relative
        target = destination / relative
        if source.is_dir():
            shutil.copytree(source, target, ignore=shutil.ignore_patterns('.DS_Store', '__pycache__', '*.log'))
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)
    for relative in ['LICENSE', 'NOTICE.md', 'Start-Windows.bat', '启动趣聊-Windows.bat',
                     'app/server.mjs', 'app/local-start.mjs', 'app/index.html', 'app/sw.js',
                     'app/manifest.webmanifest', 'app/icon.svg', 'app/data/models.js',
                     'app/data/templates.js', 'app/data/contest-templates.js',
                     'app/core', 'app/ui', 'app/voice', 'app/styles', 'app/licenses', 'app/models',
                     'app/docs/LOCAL-MODEL.md', 'app/docs/WINDOWS.md',
                     'models/MODEL_FILES.json', 'runtime/WINDOWS-RUNTIME-SOURCES.json',
                     'runtime/node/win32-x64', 'runtime/ollama/win32-x64']:
        copy(relative)
    for item in expected:
        copy(item['file'])
    copy('models/ollama/manifests/registry.ollama.ai/library/qwen3/4b-instruct-2507-q4_K_M')
    readme = (REPO / 'app/docs/WINDOWS.md').read_text()
    (destination / 'README-Windows.txt').write_bytes(b'\xef\xbb\xbf' + readme.replace('\n', '\r\n').encode())
    files = []
    for file in sorted(destination.rglob('*')):
        if not file.is_file():
            continue
        relative = file.relative_to(destination).as_posix()
        assert not file.is_symlink(), f'Unexpected link: {relative}'
        assert not relative.startswith(('app/data/db/', 'runtime/ollama/darwin', '.git/')), relative
        assert file.name != '.env' and '.backup.' not in file.name, relative
        files.append({'path': relative, 'bytes': file.stat().st_size, 'sha256': digest(file)})
    for name in ['Start-Windows.bat', '启动趣聊-Windows.bat']:
        raw = (destination / name).read_bytes()
        raw.decode('ascii')
        assert b'\r\n' in raw and b'setlocal DisableDelayedExpansion' in raw
    manifest = {'product': 'Quliao Windows x64 local-only', 'model': 'quliao-qwen3:4b',
                'node': '24.22.2', 'ollama': '0.40.13', 'includesPersonalData': False,
                'windowsExecution': 'not-run; built and inspected on macOS', 'files': files}
    (destination / 'PACKAGE_MANIFEST.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
    (destination / 'SHA256SUMS').write_text(''.join(f"{item['sha256']}  {item['path']}\n" for item in files))
    print(f'Validated {len(files)} files; writing ZIP64 archive...', flush=True)
    with zipfile.ZipFile(archive, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=1, allowZip64=True) as output:
        for file in sorted(destination.rglob('*')):
            if file.is_file():
                output.write(file, arcname=destination.name + '/' + file.relative_to(destination).as_posix())
    with zipfile.ZipFile(archive) as zipped:
        assert zipped.testzip() is None, 'Archive CRC validation failed'
        assert len(zipped.infolist()) == len(files) + 2
    archive_hash = digest(archive)
    archive.with_suffix('.zip.sha256').write_text(archive_hash + '  ' + archive.name + '\n')
    print(json.dumps({'folder': str(destination), 'archive': str(archive), 'bytes': archive.stat().st_size,
                      'sha256': archive_hash, 'files': len(files), 'windowsExecution': 'not-run'}, ensure_ascii=False), flush=True)

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('output', type=Path)
    build(parser.parse_args().output)
