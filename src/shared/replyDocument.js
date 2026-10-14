const rule = line => { const parts = tableCells(line); return line.includes('|') && parts.length >= 2 && parts.every(p => /^:?-{3,}:?$/.test(p)); };
export function inlineSpans(value) {
  const text = String(value), spans = [], runs = [...text.matchAll(/`+/g)];
  let cursor = 0;
  for (let i = 0; i < runs.length; i++) {
    const open = runs[i];
    if (open.index < cursor) continue;
    const closeIndex = runs.findIndex((run, index) => index > i && run[0].length === open[0].length);
    if (closeIndex < 0) continue;
    const close = runs[closeIndex];
    if (open.index > cursor) spans.push({text:text.slice(cursor,open.index),code:false});
    spans.push({text:text.slice(open.index+open[0].length,close.index),code:true});
    cursor = close.index + close[0].length;
    i = closeIndex;
  }
  if (cursor < text.length) spans.push({text:text.slice(cursor),code:false});
  return spans;
}
export function tableCells(line) {
  const text = line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '');
  let cell = '', escaped = false;
  const result = [];
  // Preserve the original code delimiters for the renderer, while protecting
  // every pipe inside a matched span (including spans delimited by ``).
  const runs = [...text.matchAll(/`+/g)];
  let codeEnd = -1;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (escaped) { cell += char === '|' ? '|' : `\\${char}`; escaped = false; continue; }
    if (char === '\\' && i > codeEnd) { escaped = true; continue; }
    if (char === '`' && i > codeEnd) {
      const open = runs.find(run => run.index === i);
      const close = open && runs.find(run => run.index > i && run[0].length === open[0].length);
      if (close) codeEnd = close.index + close[0].length - 1;
    }
    if (char === '|' && i > codeEnd) { result.push(cell.trim()); cell = ''; } else cell += char;
  }
  if (escaped) cell += '\\';
  result.push(cell.trim()); return result;
}
export function parseReplyDocument(value = '') {
  const lines = String(value).replace(/\r\n/g, '\n').split('\n'), blocks = [];
  let i = 0, paragraph = [];
  const flush = () => { if (paragraph.length) blocks.push({type:'paragraph', text:paragraph.join('\n')}); paragraph = []; };
  while (i < lines.length) {
    const line = lines[i], trim = line.trim();
    if (!trim) { flush(); i++; continue; }
    const fence = /^(?<marker>`{3,}|~{3,})(?<language>[^\s]*)\s*$/.exec(trim);
    if (fence) {
      flush(); const text = [], {marker,language} = fence.groups; i++;
      while (i < lines.length && !lines[i].trim().startsWith(marker)) text.push(lines[i++]);
      blocks.push({type:'code',language,text:text.join('\n')}); if(i < lines.length) i++; continue;
    }
    if (i+1 < lines.length && line.includes('|') && rule(lines[i+1])) {
      flush(); const rows = [tableCells(line)]; i+=2;
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) { if (!rule(lines[i])) rows.push(tableCells(lines[i])); i++; }
      blocks.push({type:'table',rows}); continue;
    }
    if (/^(?:[-*_]\s*){3,}$/.test(trim)) { flush(); i++; continue; }
    if (i+1 < lines.length && /^(?:={3,}|-{3,})$/.test(lines[i+1].trim())) { flush(); blocks.push({type:'heading',text:trim}); i+=2; continue; }
    if (/^#{1,6}\s+/.test(trim)) { flush(); blocks.push({type:'heading',text:trim.replace(/^#{1,6}\s+|\s+#+$/g,'')}); i++; continue; }
    if (/^>\s?/.test(trim)) { flush(); blocks.push({type:'quote',text:trim.replace(/^(?:>\s?)+/,'')}); i++; continue; }
    const list = /^(\s*)([-*+]|\d+[.)])\s+(?:\[([ xX])\]\s+)?(.*)$/.exec(line);
    if (list) {
      flush();
      blocks.push({type:'list',text:list[4],marker:/^\d/.test(list[2])?list[2]:'•',indent:list[1].replaceAll('\t','    ').length,checked:list[3] === undefined ? null : list[3].toLowerCase() === 'x'});
      i++; continue;
    }
    paragraph.push(line); i++;
  }
  flush(); return blocks;
}
export function readableInline(value) {
  // Protect literals in code spans instead of deleting operators/underscores.
  return inlineSpans(value).map(({text,code})=>code?text:text.replace(/\*\*\*([^*]+)\*\*\*|\*\*([^*]+)\*\*|__([^_]+)__|~~([^~]+)~~/g,(_,a,b,c,d)=>a||b||c||d).replace(/(^|[\s（(])\*([^*\n]+)\*(?=$|[\s，。！？.,!?)）])/gu,'$1$2').replace(/(^|[\s（(])_([^_\n]+)_(?=$|[\s，。！？.,!?)）])/gu,'$1$2')).join('');
}
export function replyPlainText(value) {
  let previous;
  return parseReplyDocument(value).map(b=>{
    const prefix = previous ? previous === 'list' && b.type === 'list' ? '\n' : '\n\n' : '';
    previous = b.type;
    const marker = b.checked == null ? b.marker : b.checked ? '☑' : '☐';
    return prefix + (b.type==='table'?b.rows.map(r=>r.map(readableInline).join('\t')).join('\n'):b.type==='code'?b.text:(b.type==='list'?' '.repeat(b.indent)+marker+' ':'')+readableInline(b.text));
  }).join('');
}
