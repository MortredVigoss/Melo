export { parseReplyDocument, tableCells, readableInline, replyPlainText } from '../shared/replyDocument.js';
import { parseReplyDocument, readableInline, inlineSpans } from '../shared/replyDocument.js';
export function renderReplyDocument(value, inline, escape) {
  const render=text=>inlineSpans(text).map(span=>span.code?`<code>${escape(span.text)}</code>`:inline(readableInline(span.text))).join('');
  return parseReplyDocument(value).map(b=>{
    if(b.type==='table') { const [head,...rows]=b.rows; return `<div class="reply-table-scroll"><table class="reply-table"><thead><tr>${head.map(v=>`<th>${render(v)}</th>`).join('')}</tr></thead><tbody>${rows.map(row=>`<tr>${Array.from({length:Math.max(head.length,row.length)},(_,i)=>`<td data-label="${escape(readableInline(head[i]||''))}">${render(row[i]||'—')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`; }
    if(b.type==='code') return `<div class="message-code-block" data-copyable-surface data-copy-text="${escape(b.text)}"><div class="message-code-label">${escape(b.language||'代码')}</div><pre><code>${escape(b.text)}</code></pre></div>`;
    if(b.type==='heading') return `<p class="reply-heading">${render(b.text)}</p>`;
    if(b.type==='list') return `<div class="reply-list-item" data-list-indent="${Math.max(0,Math.min(Math.floor(b.indent),24))}"><span>${escape(b.checked == null ? b.marker : b.checked ? '☑' : '☐')}</span><p>${render(b.text)}</p></div>`;
    if(b.type==='quote') return `<blockquote>${render(b.text)}</blockquote>`;
    return `<p>${render(b.text)}</p>`;
  }).join('');
}
