// Durable image identities outlive execution-scene retention and URL secrets.
// Records come from saved tool observations, never from a client-supplied path.
import { mkdir, readFile, writeFile, rename, realpath, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const validRunId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
export const imageHomeScope = home => createHash('sha256').update(resolve(home)).digest('hex').slice(0, 24);
export const imageRecordId = artifact => createHash('sha256').update(String(artifact.id)).digest('hex');
const directory = home => join(home, 'desktop', 'image-records');
const fileFor = (home, runId) => validRunId(runId) ? join(directory(home), `${runId}.json`) : null;

export async function readImageRecords(home, runId) {
  const file = fileFor(home, runId);
  if (!file) return null;
  try {
    const record = JSON.parse(await readFile(file, 'utf8'));
    return record.version === 1 && record.runId === runId && record.homeScope === imageHomeScope(home)
      && Array.isArray(record.artifacts) ? record : null;
  } catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return null; throw error; }
}

const writes = new Map();
async function queueImageWrite(home, runId, write) {
  const key = `${home}\0${runId}`;
  const pending = (writes.get(key) || Promise.resolve()).catch(() => {}).then(write);
  writes.set(key, pending);
  try { return await pending; }
  finally { if (writes.get(key) === pending) writes.delete(key); }
}

export async function archiveSceneImages(home, scene, workspacePath = null) {
  const snapshot = structuredClone(scene);
  return queueImageWrite(home, snapshot?.runId, () => writeSceneImages(home, snapshot, workspacePath));
}

// The resource service verifies the saved attachment, recorded path and bytes
// before requesting a binding. Share the archival lock to avoid lost updates.
export async function bindImageWorkspace(home, runId, artifact, binding) {
  const expected = structuredClone(artifact), pinned = structuredClone(binding);
  return queueImageWrite(home, runId, async () => {
    const record = await readImageRecords(home, runId);
    const current = record?.artifacts.find(a => a.key === expected.key);
    if (!current || current.path !== expected.path || current.originalUrl !== expected.originalUrl) return null;
    if (!current.workspacePath) {
      current.workspacePath = pinned.workspacePath;
      current.canonicalRoot = pinned.canonicalRoot;
      await writeRecord(home, runId, record);
    }
    return record;
  });
}

async function writeSceneImages(home, scene, workspacePath) {
  const file = fileFor(home, scene?.runId);
  const images = (scene?.artifacts || []).filter(a => a.kind === 'image' && a.path?.startsWith('/'));
  if (!file || !scene.chatId || !images.length) return;
  const previous = await readImageRecords(home, scene.runId);
  const canonicalRoot = workspacePath ? await realpath(workspacePath).catch(() => null) : null;
  const record = {
    version: 1, homeScope: imageHomeScope(home), runId: scene.runId, chatId: scene.chatId,
    workspacePath: previous?.workspacePath || workspacePath,
    canonicalRoot: previous?.canonicalRoot || canonicalRoot,
    artifacts: [...new Map([...(previous?.artifacts || []), ...images.map(artifact => {
      const key = imageRecordId(artifact);
      const prior = previous?.artifacts.find(a => a.key === key && a.path === artifact.path);
      return {
        id: artifact.id, key, path: artifact.path,
        url: artifact.url, originalUrl: prior?.originalUrl || artifact.originalUrl || artifact.url,
        title: artifact.title || 'Melo-image',
        ...(prior?.workspacePath ? { workspacePath: prior.workspacePath, canonicalRoot: prior.canonicalRoot } : {}),
      };
    })].map(artifact => [artifact.key, artifact])).values()],
  };
  await writeRecord(home, scene.runId, record);
}

async function writeRecord(home, runId, record) {
  const file = fileFor(home, runId);
  await mkdir(directory(home), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(record), { mode: 0o600 });
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }).catch(() => {}); }
}
