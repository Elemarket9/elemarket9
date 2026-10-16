"""Build and re-read a clean source ZIP with an exact SHA-256 inventory."""
from pathlib import Path
import hashlib
import json
import zipfile

root = Path(__file__).resolve().parents[1]
output = root.parent / 'artifacts'
output.mkdir(exist_ok=True)
excluded = {'node_modules', '.git', '.verification-postgres', 'verification', 'artifacts', '.output', '.nitro', '.vercel', 'dist', 'coverage', '__pycache__', '.vite', '.turbo', 'playwright-report', 'test-results', '.expo'}

def included(path):
    relative = path.relative_to(root)
    return (not any(part in excluded for part in relative.parts)
            and path.suffix.lower() not in {'.zip', '.log', '.pyc'}
            and (not path.name.startswith('.env') or path.name == '.env.example'))

files = sorted((p for p in root.rglob('*') if p.is_file() and included(p)), key=lambda p: p.relative_to(root).as_posix())
info_path = root / 'PACKAGE-INFO.json'
info = json.loads(info_path.read_text(encoding='utf-8'))
info['files'] = len(files)
info_path.write_text(json.dumps(info, indent=2) + '\n', encoding='utf-8')
manifest = {p.relative_to(root).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in files if p.name != 'SOURCE-MANIFEST.sha256'}
(root / 'SOURCE-MANIFEST.sha256').write_text(''.join(f'{digest}  {name}\n' for name, digest in manifest.items()), encoding='utf-8')
archive = output / 'ELEMARKET_EIDE_POSTGRES_VERIFIED_RELEASE_HOLD_2026-10-15.zip'
with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as z:
    for p in files:
        z.write(p, 'elemarket9-main/' + p.relative_to(root).as_posix())
with zipfile.ZipFile(archive) as z:
    assert z.testzip() is None
    expected = {'elemarket9-main/' + name for name in manifest} | {'elemarket9-main/SOURCE-MANIFEST.sha256'}
    assert set(z.namelist()) == expected
    for name, digest in manifest.items():
        assert hashlib.sha256(z.read('elemarket9-main/' + name)).hexdigest() == digest, name
    migration_manifest = json.loads(z.read('elemarket9-main/migrations.sha256.json'))
    for name, digest in migration_manifest.items():
        assert hashlib.sha256(z.read('elemarket9-main/migrations/' + name)).hexdigest() == digest, name
result = {'archive': archive.name, 'sha256': hashlib.sha256(archive.read_bytes()).hexdigest(), 'files': len(files), 'manifest_entries': len(manifest), 'deployment_migrations': len(migration_manifest), 'zip_crc': 'PASS', 'exact_manifest_parity': 'PASS', 'source_sha256': 'PASS', 'migration_sha256': 'PASS'}
(output / 'PACKAGE-VERIFICATION.json').write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')
print(json.dumps(result, indent=2))
