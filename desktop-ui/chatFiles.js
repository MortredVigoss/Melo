import {t,ui} from './i18n.js';

// Mounted outside the application root so polling cannot dismiss a decision.
export function askFileDecision({title='',rootPath='',exists=false,projectFilesPreserved=false,retained=false}={}) {
  return new Promise(resolve=>{
    const dialog=document.createElement('dialog');
    dialog.className='chat-file-dialog';
    const heading=document.createElement('h2');heading.textContent=t(retained?'清理对话文件':'删除对话');
    const description=document.createElement('p');description.textContent=title;
    const help=document.createElement('p');help.textContent=t(exists?'是否同时删除这个对话专属目录里的文件？':'此对话没有专属文件目录。');
    const path=document.createElement('p');path.className='mono';path.textContent=rootPath || '';
    const actions=document.createElement('div');actions.className='inline-actions';
    const finish=value=>{dialog.close();dialog.remove();resolve(value);};
    for(const [value,label] of [['cancel','取消'],['keep',retained?'保留文件':exists?'删除对话，保留文件':'删除对话'],...(exists?[['delete',retained?'删除文件':'同时删除文件']]:[])]) {
      const button=document.createElement('button');button.type='button';button.className='small-button';button.textContent=t(label);button.addEventListener('click',()=>finish(value));actions.append(button);
    }
    dialog.append(heading,description,help,path);
    if(projectFilesPreserved){const note=document.createElement('p');note.textContent=t('项目工作区的文件会保留。');dialog.append(note);}
    dialog.append(actions);dialog.addEventListener('cancel',event=>{event.preventDefault();finish('cancel');});document.body.append(dialog);dialog.showModal();actions.firstElementChild.focus();
  });
}
export function renderRetainedFiles(result,escapeHtml) {
  if(!result) return '';
  return ui`<section class="subsection"><h3>已删除对话的文件</h3><p>手机删除的对话和历史遗留文件会保留在这里，等待你决定文件去留。</p>${(result.directories || []).map(item=>ui`<div class="list-row"><strong>${escapeHtml(item.title)}</strong><span class="chip">${t(item.decision==='keep'?'已保留':'待确认')}</span><p class="mono">${escapeHtml(item.rootPath || item.error || '')}</p>${item.exists?ui`<div class="inline-actions"><button class="small-button" data-action="open-retained-files" data-chat-id="${escapeHtml(item.chatId)}">在 Finder 中打开</button><button class="small-button" data-action="decide-retained-files" data-chat-id="${escapeHtml(item.chatId)}">处理文件</button></div>`:''}</div>`).join('') || ui`<p>没有待处理的对话文件。</p>`}</section>`;
}
