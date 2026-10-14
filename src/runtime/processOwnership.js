export function selectOwnedDaemonPids(table, { uid, ownNames = new Set(), includeOrphans = false, isAlive = () => true } = {}) {
  const pids = [];
  for (const line of String(table || '').split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+.*(?:^|\/)cliDaemon\.js\s+(\S+)\s*$/);
    if (!match || Number(match[2]) !== uid) continue;
    const name = match[3];
    const owner = name.match(/^melo-(?:shared|search)-p(\d+)-[a-f0-9]{8}$/);
    if (ownNames.has(name) || (includeOrphans && owner && !isAlive(Number(owner[1])))) pids.push(Number(match[1]));
  }
  return pids;
}
