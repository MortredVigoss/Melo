import { existsSync, mkdirSync, copyFileSync, cpSync, readFileSync, writeFileSync, renameSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { readAllConfig, readUserConfig, readPetConfigEntry, saveUserConfig } from '../upstream/src/host/config';
import { configPathsFor } from '../upstream/src/standalone/options';
import { createHash } from 'node:crypto';

/** Each pack backup is ~200MB: once an upgrade is published, keep only the newest non-empty one. */
function pruneBackups(dir: string, latest: string) {
  if (!readdirSync(latest).length) { rmSync(latest, { recursive: true, force: true }); return; }
  for (const name of readdirSync(dir)) {
    const backup = join(dir, name);
    if (backup === latest || !/^winter-\d+-\d+$/.test(name)) continue;
    // The upgrade already succeeded; a leftover backup must not stop the pet from starting.
    try { rmSync(backup, { recursive: true, force: true }); } catch (error) { console.error('[melo-pet-skins] old backup not removed:', backup, (error as Error).message); }
  }
}

/** Only the display selection is ours. Animation/physics/config merging stays upstream. */
export function createSkinStore(packageRoot: string, home: string, packRoot: string) {
  const paths = configPathsFor(packageRoot, home);
  const root = join(home, 'dsh-pet');
  const selectionFile = join(root, 'melo-skin.json');
  mkdirSync(paths.petDir, { recursive: true });
  const winterFile = join(paths.petDir, 'winter-config.json');
  const packText = readFileSync(join(packRoot, 'winter-config.json'), 'utf8');
  const packManifest = readFileSync(join(packRoot, 'manifest.json'), 'utf8');
  const revision = createHash('sha256').update(packText).update(packManifest).digest('hex');
  const installedFile = join(root, 'winter-pack-revision.json');
  const animationDir = join(paths.petDir, 'winter-animation');
  const installed = existsSync(installedFile) ? JSON.parse(readFileSync(installedFile, 'utf8')).revision : '';
  if (installed !== revision || !existsSync(winterFile) || !existsSync(animationDir)) {
    // A new bundled skin must upgrade existing profiles as well as fresh ones.
    // Keep positions/preferences, replace only the animation contract and files.
    const pack = JSON.parse(packText);
    const existing = existsSync(winterFile) ? JSON.parse(readFileSync(winterFile, 'utf8')) : {};
    const next = { ...pack, ...existing, animations: pack.animations, animationWeights: pack.animationWeights };
    const stamp = `${Date.now()}-${process.pid}`;
    const stage = join(paths.petDir, '.winter-animation-next-' + stamp);
    const backup = join(root, '.melo-backups', 'winter-' + stamp);
    cpSync(join(packRoot, 'winter-animation'), stage, { recursive: true });
    writeFileSync(winterFile + '.melo-next', JSON.stringify(next, null, 2), { mode: 0o600 });
    mkdirSync(backup, { recursive: true });
    if (existsSync(winterFile)) copyFileSync(winterFile, join(backup, 'winter-config.json'));
    if (existsSync(animationDir)) renameSync(animationDir, join(backup, 'winter-animation'));
    try {
      renameSync(stage, animationDir);
      renameSync(winterFile + '.melo-next', winterFile);
      writeFileSync(installedFile + '.melo-next', JSON.stringify({ revision }), { mode: 0o600 });
      renameSync(installedFile + '.melo-next', installedFile);
    } catch (error) {
      if (!existsSync(animationDir) && existsSync(join(backup, 'winter-animation'))) renameSync(join(backup, 'winter-animation'), animationDir);
      throw error;
    }
    pruneBackups(join(root, '.melo-backups'), backup);
  }
  let selected = existsSync(selectionFile) ? JSON.parse(readFileSync(selectionFile, 'utf8')).skin : 'main';
  if (!['main', 'winter'].includes(selected)) throw new Error('皮肤选择记录无效');

  function select(skin: string) {
    if (!['main', 'winter'].includes(skin)) throw new Error('未知皮肤');
    const merged = readAllConfig(paths);
    const mainExisting = readUserConfig(paths) ?? {};
    const winter = readPetConfigEntry(paths, 'winter');
    if (!winter) throw new Error('金冬天皮肤配置缺失');
    const mapPets = (pets: any[]) => pets.map(p => ({ ...p, ...(p.id === 'main' ? { name: '大肥鱼' } : {}), display: p.id === skin ? 'desktop' : 'none' }));
    const main = saveUserConfig({ pets: mapPets(merged.main.pets as any[]) }, mainExisting);
    const winterConfig = saveUserConfig({ pets: mapPets(merged.winter.pets as any[]) }, winter.raw);
    if (!main || !winterConfig) throw new Error('皮肤配置无效');
    const writes: Array<[string, string]> = [
      [paths.userFile, JSON.stringify(main, null, 2)],
      [winter.path, JSON.stringify(winterConfig, null, 2)],
      [selectionFile, JSON.stringify({ skin }, null, 2)],
    ];
    // Prepare every file before publishing; helper reload only starts after all writes finish.
    for (const [file, data] of writes) writeFileSync(file + '.melo-next', data, { mode: 0o600 });
    for (const [file] of writes) renameSync(file + '.melo-next', file);
    selected = skin;
    return { skin, config: readAllConfig(paths) };
  }

  if (!existsSync(paths.userFile)) {
    const defaults = readAllConfig(paths).main;
    const pets = (defaults.pets as any[]).map(p => ({ ...p, display: p.id === selected ? 'desktop' : 'none', balanceEnabled: false, whisperEnabled: false }));
    writeFileSync(paths.userFile, JSON.stringify({ pets, notificationsEnabled: false, chatImageEnabled: false }, null, 2), { mode: 0o600 });
  }
  // The saved choice is authoritative after restart, including an interrupted two-file update.
  select(selected);
  return { select, get selected() { return selected; }, paths };
}
