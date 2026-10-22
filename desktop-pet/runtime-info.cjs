'use strict';
// The controller's runtime record for Melo: pid, control URL and token, readable
// only by the local user (0600). Written once the control server listens and
// removed on shutdown, so a present file with a live pid means a running pet.
const fs = require('node:fs');

function writeRuntimeInfo(file, info) {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(info, null, 2), { mode: 0o600 });
  fs.chmodSync(temporary, 0o600);
  fs.renameSync(temporary, file);
  return file;
}

function readRuntimeInfo(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch { return null; }
}

/** Removes the record only when it still describes this process; a newer instance keeps its own. */
function removeRuntimeInfo(file, pid) {
  const current = readRuntimeInfo(file);
  if (!current || current.pid !== pid) return false;
  try { fs.unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return true;
}

module.exports = { writeRuntimeInfo, readRuntimeInfo, removeRuntimeInfo };
