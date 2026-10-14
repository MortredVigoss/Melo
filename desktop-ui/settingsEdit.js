const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

const pendingEdits = new Set();
export const hasUnsavedSettings = () => pendingEdits.size > 0;
export function installUnsavedSettingsGuard(target) {
  target.MeloHasUnsavedSettings = hasUnsavedSettings;
  target.addEventListener('beforeunload', event => {
    if (!hasUnsavedSettings()) return;
    event.preventDefault(); event.returnValue = '';
  });
}

export class EditSession {
  status = 'readonly';
  dirty = false;
  error = '';
  revision = 0;
  get editing() { return ['editing', 'dirty', 'error'].includes(this.status); }
  begin() { if (this.status === 'saving') return; pendingEdits.delete(this); this.revision++; this.status = 'editing'; this.dirty = false; this.error = ''; }
  change() { if (!this.editing) return; pendingEdits.add(this); this.dirty = true; this.status = 'dirty'; this.error = ''; }
  cancel() { if (this.status === 'saving') return; pendingEdits.delete(this); this.revision++; this.status = 'readonly'; this.dirty = false; this.error = ''; }
  start() { if (!this.editing || !this.dirty) return false; pendingEdits.add(this); this.status = 'saving'; this.error = ''; return true; }
  saved() { pendingEdits.delete(this); this.revision++; this.status = 'saved'; this.dirty = false; this.error = ''; }
  failed(error) { pendingEdits.add(this); this.status = 'error'; this.dirty = true; this.error = error?.message || String(error || '保存失败，请重试'); }
}

export function renderEditActions(session, {prefix='settings', key='', submit=false, disabled=false, saveDisabled=false}={}) {
  const s = session.status, editing = session.editing || s === 'saving';
  const message = s === 'saved' ? '✓ 已保存' : s === 'saving' ? '正在保存，请稍候…' : s === 'error' ? `${session.appliedLabels?.length ? '部分已保存，剩余保存失败' : '保存失败'}：${session.error}` : session.dirty ? '有未保存的修改' : editing ? '编辑中 · 修改后点击保存' : '只读 · 点击编辑后修改';
  const common = `data-edit-key="${escape(key)}"`;
  return `<div class="settings-edit-toolbar" data-edit-status="${s}"><span class="settings-save-status" role="${s==='error'?'alert':'status'}" aria-live="polite">${escape(message)}</span><div class="inline-actions">${editing ? `<button type="${submit?'submit':'button'}" class="small-button settings-save-button" data-action="${prefix}-save" ${common} ${disabled||saveDisabled||s==='saving'||!session.dirty?'disabled':''}>${s==='saving'?'保存中…':s==='error'?'重试保存':'保存修改'}</button><button type="button" class="small-button" data-action="${prefix}-cancel" ${common} ${disabled||s==='saving'?'disabled':''}>${session.appliedLabels?.length ? '放弃未保存部分' : '取消'}</button>` : `<button type="button" class="small-button settings-edit-button" data-action="${prefix}-edit" ${common} ${disabled?'disabled':''}>编辑 / 修改</button>`}</div></div>`;
}

// Keep the save button mounted while a field's blur/change event fires.
// Replacing it between pointerdown and click silently drops the click.
export function paintEditActions(bar, session, options={}) {
  if (!bar) return;
  const template=bar.ownerDocument.createElement('template');
  template.innerHTML=renderEditActions(session,options);
  const next=template.content.firstElementChild;
  const buttons=[...bar.querySelectorAll('button')], incoming=[...next.querySelectorAll('button')];
  if(buttons.length!==incoming.length || buttons.some((b,i)=>b.dataset.action!==incoming[i].dataset.action)) {bar.replaceWith(next);return;}
  bar.dataset.editStatus=session.status;
  const label=bar.querySelector('.settings-save-status'), nextLabel=next.querySelector('.settings-save-status');
  label.textContent=nextLabel.textContent;label.setAttribute('role',nextLabel.getAttribute('role'));
  buttons.forEach((button,i)=>{button.disabled=incoming[i].disabled;button.textContent=incoming[i].textContent;});
}

// Existing form handlers still own persistence. This layer only manages the
// explicit edit boundary and reflects their acknowledged success or failure.
export function createSettingsFormEditors({render, onCancel, scope=()=>'', ownsDraft=()=>false}) {
  const sessions = new Map();
  const drafts = new Map();
  const selector = ['agent-profile-update','connector-config','model-config','default-model-config','skill-custom-update','project-update','task-pricing'].map(t=>`form[data-form="${t}"]`).join(',');
  const savedActions = new Set(['test-agent-channel']);
  const safeActions = new Set(['select-agent-editor-tab','switch-agent-channel-tab','toggle-agent-secret']);
  const keyFor = form => `${form.dataset.form}:${form.dataset.agentId || form.dataset.skillId || form.dataset.projectId || ''}:${scope(form)}`;
  const get = key => { if(!sessions.has(key)) sessions.set(key,new EditSession()); return sessions.get(key); };
  function decorate(root) {
    for (const form of root.querySelectorAll(selector)) {
      const key = keyFor(form), session = get(key);
      form.dataset.settingsManaged = key;
      const draft=drafts.get(key);
      if(draft) for(const control of form.querySelectorAll('input[name],textarea[name],select[name]')) {
        const value=draft.get(control.name);
        if(value===undefined || ['hidden','file'].includes(control.type)) continue;
        if(['checkbox','radio'].includes(control.type)) control.checked=value.includes(control.value);
        else control.value=value;
      }
      for (const control of form.querySelectorAll('input,textarea,select,button')) {
        if(control.closest('.settings-edit-toolbar')) continue;
        if(control.type==='hidden' || safeActions.has(control.dataset.action)) continue;
        if(control.dataset.settingsOriginalDisabled===undefined) control.dataset.settingsOriginalDisabled=String(control.disabled);
        control.disabled = (savedActions.has(control.dataset.action) ? session.editing || session.status==='saving' : !session.editing) || control.dataset.settingsOriginalDisabled==='true';
        if(control.tagName==='BUTTON' && control.type==='submit') control.hidden = true;
      }
      let bar = form.querySelector(':scope > .settings-edit-toolbar');
      const html = renderEditActions(session,{prefix:'form-settings',key,submit:true});
      if(bar) bar.outerHTML=html; else form.insertAdjacentHTML('afterbegin',html);
      for(const external of root.querySelectorAll('[data-action="submit-agent-profile"]')) if(external.dataset.formId===form.id) external.hidden=true;
    }
  }
  function changed(event) {
    const form=event.target.closest?.(selector); if(!form) return;
    const session=get(keyFor(form));
    if(!session.editing) { event.stopImmediatePropagation(); event.preventDefault(); return; }
    session.change();
    const target=event.target;
    if(!ownsDraft(form) && target.name && !['hidden','file'].includes(target.type)) {
      const key=keyFor(form);
      if(!drafts.has(key))drafts.set(key,new Map());
      const value=['checkbox','radio'].includes(target.type)
        ? [...form.querySelectorAll('input')].filter(c=>c.name===target.name && c.checked).map(c=>c.value)
        : target.value;
      drafts.get(key).set(target.name,value);
    }
    // Update only the status controls; don't replace the input or move its caret.
    const bar=form.querySelector(':scope > .settings-edit-toolbar');
    paintEditActions(bar,session,{prefix:'form-settings',key:keyFor(form),submit:true});
  }
  function install(doc) {
    doc.addEventListener('input',changed,true); doc.addEventListener('change',changed,true);
    doc.addEventListener('click',event=>{
      const button=event.target.closest?.('button'); if(!button) return;
      const action=button.dataset.action, key=button.dataset.editKey;
      if(action==='form-settings-edit' || action==='form-settings-cancel') {
        event.preventDefault(); event.stopImmediatePropagation();
        if(get(key).status==='saving') return;
        if(action.endsWith('-edit')) get(key).begin(); else {get(key).cancel();drafts.delete(key);const form=button.closest('form');onCancel(form);form.reset();}
        render(); return;
      }
      const form=button.closest(selector);
      if(form && action && !safeActions.has(action) && !savedActions.has(action) && !action.startsWith('form-settings-')) changed(event);
    },true);
  }
  return {decorate,install,
    editToken(form) { const session=get(keyFor(form)), revision=session.revision; return ()=>session.editing && session.revision===revision; },
    start(form) { if(!form.matches(selector)) return null; const key=keyFor(form); return get(key).start()?key:false; },
    finish(key,error) { if(!key) return; if(error)get(key).failed(error);else{get(key).saved();drafts.delete(key);} render(); },
  };
}
