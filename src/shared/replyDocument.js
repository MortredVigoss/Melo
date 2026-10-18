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

// Shared presentation tokens; native Hosts apply their own fonts and layout.
export function inlinePresentation(value = '') {
  const result = [];
  const append = (value, style) => { if (value) result.push({ text: value, ...style }); };
  const safeLink = value => /^https?:\/\/[^\s/@]+(?:[/?#][^\s]*)?$/iu.test(value) && value.length <= 4000;
  function parse(text, style = {}, depth = 0) {
    if (depth > 6) { append(text, style); return; }
    let start = 0, index = 0;
    const flush = () => { append(text.slice(start, index), style); };
    while (index < text.length) {
      if (text[index] === '`') {
        const marker = /^`+/u.exec(text.slice(index))[0];
        const end = text.indexOf(marker, index + marker.length);
        if (end >= index + marker.length) { flush(); append(text.slice(index + marker.length, end), { ...style, code: true }); index = end + marker.length; start = index; continue; }
      }
      if (text[index] === '\\' && /[\\`*_~\[\]()]/.test(text[index + 1] || '')) {
        flush(); append(text[index + 1], style); index += 2; start = index; continue;
      }
      if (text[index] === '[') {
        const labelEnd = text.indexOf('](', index + 1);
        if (labelEnd > index && labelEnd - index < 1000) {
          let close = labelEnd + 2, balance = 1;
          for (; close < text.length && close - labelEnd <= 4000; close++) {
            if (/\s/u.test(text[close])) break;
            if (text[close] === '(') balance++;
            if (text[close] === ')' && --balance === 0) break;
          }
          const raw = text.slice(labelEnd + 2, close);
          const url = raw.startsWith('<') && raw.endsWith('>') ? raw.slice(1, -1) : raw;
          if (balance === 0 && safeLink(url)) { flush(); parse(text.slice(index + 1, labelEnd), { ...style, url }, depth + 1); index = close + 1; start = index; continue; }
        }
      }
      const markers = [['***', { bold: true, italic: true }], ['**', { bold: true }], ['__', { bold: true }], ['~~', { strike: true }], ['*', { italic: true }], ['_', { italic: true }]];
      let matched = false;
      for (const [marker, flags] of markers) {
        if (!text.startsWith(marker, index) || marker.includes('_') && /[\p{L}\p{N}]/u.test(text[index - 1] || '') || /\s/u.test(text[index + marker.length] || ' ')) continue;
        const end = text.indexOf(marker, index + marker.length);
        if (end <= index + marker.length || /\s/u.test(text[end - 1])) continue;
        flush(); parse(text.slice(index + marker.length, end), { ...style, ...flags }, depth + 1); index = end + marker.length; start = index; matched = true; break;
      }
      if (matched) continue;
      if (/^https?:\/\//iu.test(text.slice(index, index + 8))) {
        const raw = /^https?:\/\/[^\s<>\[\]]+/iu.exec(text.slice(index))?.[0] || '';
        const url = raw.replace(/[.,，。！!?？;；]+$/u, '');
        if (safeLink(url)) { flush(); append(url, { ...style, url }); index += url.length; start = index; continue; }
      }
      index++;
    }
    append(text.slice(start), style);
  }
  parse(String(value));
  return result;
}

export function replyPresentation(value = '') {
  return parseReplyDocument(value).map(block => ({ ...block,
    ...(block.text !== undefined && block.type !== 'code' ? { inline: inlinePresentation(block.text) } : {}),
    ...(block.rows ? { cells: block.rows.map(row => row.map(inlinePresentation)) } : {}),
  }));
}
