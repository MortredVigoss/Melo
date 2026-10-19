// Docs-only check for the daily gate (architecture plan P0): relative links in
// the changed Markdown files must point at files or directories that exist.
// External URLs, in-page anchors, absolute machine paths and local evidence
// under .tmp/ (git-ignored) are not checked. Deleted files are skipped.
import { readFile, access } from 'node:fs/promises';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SKIP = /^(?:[a-z][a-z0-9+.-]*:|#|\/|~|<\/)/i;

export function markdownLinks(text) {
  const links = [];
  let fenced = false;
  text.split('\n').forEach((line, index) => {
    if (/^\s*(?:```|~~~)/.test(line)) { fenced = !fenced; return; }
    if (fenced) return;
    const prose = line.replace(/`[^`]*`/g, '');
    for (const match of prose.matchAll(/\]\(\s*(<[^>]*>|[^)\s]+)(?:\s+"[^"]*")?\s*\)/g)) {
      links.push({ line: index + 1, target: match[1].replace(/^<|>$/g, '') });
    }
  });
  return links;
}

export async function checkDocLinks(files, root = process.cwd()) {
  const broken = [];
  let checked = 0;
  for (const file of files) {
    const path = resolve(root, file);
    let text;
    try { text = await readFile(path, 'utf8'); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    for (const { line, target } of markdownLinks(text)) {
      if (SKIP.test(target)) continue;
      let clean = target.split('#')[0];
      if (!clean) continue;
      try { clean = decodeURIComponent(clean); } catch { /* keep the raw target */ }
      const destination = resolve(dirname(path), clean);
      const inRepo = relative(root, destination);
      if (/^\.tmp(?:\/|$)/.test(inRepo)) continue;
      checked += 1;
      try { await access(destination); } catch { broken.push(`${file}:${line} → ${target}`); }
    }
  }
  return { files: files.length, links: checked, broken };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = process.argv.slice(2);
  const result = await checkDocLinks(files);
  if (result.broken.length) {
    console.error(`文档相对链接失效 ${result.broken.length} 处：\n${result.broken.join('\n')}`);
    process.exitCode = 1;
  } else {
    console.log(`文档链接检查通过：${result.files} 个文件，${result.links} 个相对链接`);
  }
}
