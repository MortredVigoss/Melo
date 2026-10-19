// Memory feature controller (architecture plan P2, 2026-10-19): memory page,
// fact editing, project memory book and the reply-footer memory actions.
// Step 1 is a byte-for-byte move out of desktop-ui/app.js: every function body
// below is unchanged; only the action/form registration tables and the
// input/change/toggle entry points are new wiring (their bodies are the old
// `case` / listener branches). See features/README.md.
import { t } from '../../i18n.js';
import { EditSession } from '../../settingsEdit.js';
import { defaultCategory } from './viewFacts.js';
import { personalTargetId } from './viewMessageRefs.js';
import { uiState, api, render, bgRender, showError, activeProject } from './context.js';

export const memoryFactEdit = new EditSession();

// Formerly part of app.js's capture-phase 'toggle' listener.
export function handleMemoryRefsToggle(event) {
  // Bug audit U3: the reply footer «本回答参考的记忆» is rebuilt by every
  // render; remember which messages the user opened so it does not snap shut.
  const refsMessageId = event.target.dataset?.messageMemoryRefs;
  if (refsMessageId) { if (event.target.open) uiState.memoryRefsOpen[refsMessageId] = true; else delete uiState.memoryRefsOpen[refsMessageId]; }
}

async function handleMemoryRepairAction(action) {
  const m = uiState.memoryStatus;
  if (action === 'memory-pause') { m.pauseRepair = true; return; }
  if (m.repairBusy) return;
  const connection = action === 'memory-connect' ? { baseUrl: document.getElementById('memory-embed-url')?.value, model: document.getElementById('memory-embed-model')?.value } : null;
  m.repairBusy = true; m.pauseRepair = false; bgRender();
  try {
    if (action === 'memory-repair') {
      do {
        const result = await api('/api/memory/repair', { method: 'POST', body: {} });
        if (m.snapshot) m.snapshot.repair = result;
        bgRender();
        if (result.status !== 'paused') break;
      } while (!m.pauseRepair);
      await refreshMemoryStatus();
      m.diagnosis = null;
    } else {
      m.diagnosis = await api(connection ? '/api/memory/connect' : '/api/memory/diagnose', connection ? { method: 'POST', body: connection } : {});
    }
  } catch (error) { showError(error.message); }
  finally { m.repairBusy = false; bgRender(); }
}

async function handleMemoryFactAction(action, id) {
  if (uiState.memoryFactBusy) return;
  if (action === 'memory-fact-edit') { uiState.memoryFactEditing=id; const row=uiState.memoryFacts?.records.find(r=>r.id===id); uiState.memoryFactDraft={text:row?.text||'',scope:row?.scope||'chat',category:defaultCategory(row?.category),pinned:Boolean(row?.pinned)}; memoryFactEdit.begin(); uiState.memoryFactFeedback=null; bgRender(); return; }
  if (action === 'memory-fact-cancel') { uiState.memoryFactEditing=null; uiState.memoryFactDraft=null; memoryFactEdit.cancel(); bgRender(); return; }
  if (action === 'memory-fact-search') { uiState.memoryFactQuery=document.getElementById('memory-fact-query')?.value || ''; uiState.memoryFactOffset=0; await refreshMemoryStatus(); return; }
  if (action === 'memory-fact-prev' || action === 'memory-fact-next') { uiState.memoryFactOffset=Math.max(0,(uiState.memoryFactOffset || 0)+(action.endsWith('next')?50:-50)); await refreshMemoryStatus(); return; }
  if(action==='memory-fact-save' && !memoryFactEdit.start()) return;
  // Cross-device conflict (design 2026-10-17 §3.4): 采用桌面版 / 采用手机版.
  const resolveConflict=action==='memory-fact-resolve-desktop'?'desktop':action==='memory-fact-resolve-mobile'?'mobile':null;
  const patch=resolveConflict ? {resolveConflict} : action === 'memory-fact-save' ? {...uiState.memoryFactDraft} : {forgotten:action==='memory-fact-forget'};
  uiState.memoryFactBusy=true; bgRender();
  // Bug audit U10: acting on row B must not discard row A's unsaved editor.
  const closesEditor=action==='memory-fact-save'||Boolean(id&&id===uiState.memoryFactEditing);
  try { await api('/api/memory/facts/update',{method:'POST',body:{id,patch}});if(closesEditor)memoryFactEdit.saved();uiState.memoryFactFeedback={id,message:resolveConflict?(resolveConflict==='desktop'?'已采用桌面版':'已采用手机版'):action==='memory-fact-save'?t("已保存"):action==='memory-fact-forget'?'已停止使用':'已恢复使用'};if(closesEditor){uiState.memoryFactEditing=null;uiState.memoryFactDraft=null;}await refreshMemoryStatus(); }
  catch(error) { memoryFactEdit.failed(error); showError(error.message); }
  finally { uiState.memoryFactBusy=false;bgRender(); }
}

// Project memory book (design 2B): the project page lists the book and lets
// the user confirm / re-section / stop an auto row or hand-write one.
// Bug audit U14: render() only reads the cache; loading happens when the
// project page is entered / refreshed (syncProjectDetailView).
function projectBookData(projectId) {
  if (!projectId) return null;
  return uiState.projectBook?.projectId === projectId ? uiState.projectBook.data || null : null;
}
const PROJECT_BOOK_FRESH_MS = 30_000, PROJECT_BOOK_RETRY_MS = 5 * 60_000;
function loadProjectBook(projectId) {
  if (!projectId) return;
  const cached = uiState.projectBook?.projectId === projectId ? uiState.projectBook : null;
  if (cached?.loadingId === projectId) return;
  // Auto rows arrive from chats in the background: re-read after 30s, keeping
  // the stale list on screen meanwhile. After a failure, keep what we have and
  // do not retry (or alert again) for 5 minutes.
  if (cached && Date.now() - (cached.loadedAt || 0) < PROJECT_BOOK_FRESH_MS) return;
  if (cached?.failedAt && Date.now() - cached.failedAt < PROJECT_BOOK_RETRY_MS) return;
  uiState.projectBook = { ...(cached || { projectId, data: null }), projectId, loadingId: projectId };
  api(`/api/projects/memory-book?projectId=${encodeURIComponent(projectId)}`)
    .then(data => { uiState.projectBook = { projectId, data, loadedAt: Date.now() }; bgRender(); })
    .catch(error => {
      uiState.projectBook = { projectId, data: cached?.data || { records: [] }, loadedAt: cached?.loadedAt || 0, failedAt: Date.now() };
      if (!cached?.failedAt) showError(error.message);
      bgRender();
    });
}
// Bug audit U8 / U14: called whenever a bootstrap lands. Entering a project's
// page loads its memory book; leaving it drops the hand-written draft, which
// belongs to that project only.
let projectDetailKey = null;
function syncProjectDetailView(bootstrap = uiState.bootstrap) {
  const key = bootstrap?.settings?.activeView === 'projects' && bootstrap?.activeProject?.id ? bootstrap.activeProject.id : null;
  if (key !== projectDetailKey) { projectDetailKey = key; uiState.projectBookDraft = null; }
  if (key) loadProjectBook(key);
}
async function refreshProjectBook(projectId) {
  uiState.projectBook = { projectId, data: await api(`/api/projects/memory-book?projectId=${encodeURIComponent(projectId)}`), loadedAt: Date.now() };
}
// Bug audit U7 / U8: the hand-written draft is keyed by the project whose
// form it was typed into; another project's draft never leaks in.
function noteProjectBookDraft(form, patch) {
  const projectId = form?.dataset?.projectId || activeProject()?.id;
  if (!projectId) return;
  const current = uiState.projectBookDraft?.projectId === projectId ? uiState.projectBookDraft : {};
  uiState.projectBookDraft = { ...current, ...patch, projectId };
}
async function handleProjectBookAction(action, id, { section = null, form = null } = {}) {
  const projectId = activeProject()?.id;
  if (!projectId || uiState.projectBookBusy) return;
  uiState.projectBookBusy = true; uiState.projectBookFeedback = null; bgRender();
  try {
    if (action === 'project-book-create') {
      const data = new FormData(form);
      await api('/api/projects/memory-book', { method: 'POST', body: { projectId, text: String(data.get('text') || ''), section: String(data.get('section') || 'convention') } });
      uiState.projectBookDraft = null; uiState.projectBookFeedback = t('已写入记忆本');
    } else {
      const patch = action === 'project-book-confirm' ? { bookStatus: 'confirmed' }
        : action === 'project-book-section' ? { section }
        : { forgotten: action === 'project-book-forget' };
      await api('/api/memory/facts/update', { method: 'POST', body: { id, patch } });
      uiState.projectBookFeedback = action === 'project-book-confirm' ? t('已确认') : action === 'project-book-section' ? t('已改节') : action === 'project-book-forget' ? t('已停止使用') : t('已恢复使用');
    }
    await refreshProjectBook(projectId);
    if (uiState.memoryFacts) await refreshMemoryStatus();
  } catch (error) { showError(error.message); }
  finally { uiState.projectBookBusy = false; bgRender(); }
}

// Reply-footer memory actions (design audit M5): promote a referenced fact to
// the project / personal scope, or stop using it, right where it was seen.
let memoryRefFeedbackTimer = null;
async function handleMemoryRefAction(action, id, scope, { kind = null, messageId = null } = {}) {
  if (!id || uiState.memoryFactBusy) return;
  // Bug audit U15: 记成个人 on a project-book mirror row promotes the underlying
  // chat fact and leaves the book row alone (the mirror would otherwise vanish
  // from the book and never be re-created).
  const targetId = action === 'memory-ref-scope' && scope === 'personal' ? personalTargetId({ id, kind }) : id;
  if (!targetId) return;
  const patch = action === 'memory-ref-forget' ? { forgotten: true } : { scope };
  uiState.memoryFactBusy = true; bgRender();
  try {
    await api('/api/memory/facts/update', { method: 'POST', body: { id: targetId, patch } });
    // Bug audit M14a / U9: the footer feedback is tied to the message it was
    // clicked in and clears itself after 8 s (it used to persist across chats).
    uiState.memoryRefFeedback = { id, messageId, message: action === 'memory-ref-forget' ? t('已停止使用') : scope === 'project' ? t('已记到项目') : t('已记成个人') };
    const shown = uiState.memoryRefFeedback;
    clearTimeout(memoryRefFeedbackTimer);
    memoryRefFeedbackTimer = setTimeout(() => { if (uiState.memoryRefFeedback === shown) { uiState.memoryRefFeedback = null; bgRender(); } }, 8000);
    if (uiState.memoryFacts) await refreshMemoryStatus();
  } catch (error) { showError(error.message); }
  finally { uiState.memoryFactBusy = false; bgRender(); }
}

async function refreshMemoryStatus() {
  if (uiState.memoryStatus.loading) return;
  uiState.memoryStatus.loading = true;
  uiState.memoryStatus.error = null;
  bgRender();
  try {
    const [response, facts] = await Promise.all([api('/api/memory/status'), api(`/api/memory/facts?q=${encodeURIComponent(uiState.memoryFactQuery || '')}&offset=${uiState.memoryFactOffset || 0}`)]);
    uiState.memoryFacts = facts;
    uiState.memoryStatus.snapshot = response;
    if (!uiState.memoryConnection && response.connection) uiState.memoryConnection = response.connection;
    uiState.memoryStatus.loaded = true;
  } catch (err) {
    uiState.memoryStatus.error = err?.message || 'Failed to load memory status';
  } finally {
    uiState.memoryStatus.loading = false;
    bgRender();
  }
}

async function doWipeEmbeddings() {
  if (uiState.memoryStatus.wipeInFlight) return;
  uiState.memoryStatus.wipeInFlight = true;
  uiState.memoryStatus.wipeResult = null;
  render();
  try {
    const response = await api('/api/memory/wipe-embeddings', {
      method: 'POST',
      body: { confirm: 'YES, WIPE EMBEDDINGS' },
    });
    uiState.memoryStatus.wipeResult = `Cleared ${response.cleared} embeddings (dims=${response.dims}).`;
  } catch (err) {
    uiState.memoryStatus.wipeResult = `Wipe failed: ${err?.message || 'unknown error'}`;
  } finally {
    uiState.memoryStatus.wipeInFlight = false;
    uiState.memoryStatus.wipeConfirmOpen = false;
    render();
    // Refresh to reflect the new counts.
    refreshMemoryStatus();
  }
}

// Click actions, formerly `case` branches of app.js's click dispatch. Each
// handler body is the old case body without its `break`.
const memoryFactCase = async ({ action, trigger }) => {
  await handleMemoryFactAction(action,trigger.dataset.id || trigger.closest('[data-memory-record]')?.dataset.memoryRecord);
};
const memoryRefCase = async ({ action, trigger }) => {
  await handleMemoryRefAction(action, trigger.dataset.memoryId, trigger.dataset.scope, { kind: trigger.dataset.kind || null, messageId: trigger.closest('[data-message-memory-refs]')?.dataset.messageMemoryRefs || null });
};
const projectBookCase = async ({ action, trigger }) => {
  await handleProjectBookAction(action, trigger.dataset.id);
};
const memoryRepairCase = async ({ action }) => {
  await handleMemoryRepairAction(action);
};
export const memoryActions = {
  'memory-fact-search': memoryFactCase,
  'memory-fact-prev': memoryFactCase,
  'memory-fact-next': memoryFactCase,
  'memory-fact-edit': memoryFactCase,
  'memory-fact-cancel': memoryFactCase,
  'memory-fact-save': memoryFactCase,
  'memory-fact-forget': memoryFactCase,
  'memory-fact-restore': memoryFactCase,
  'memory-fact-resolve-desktop': memoryFactCase,
  'memory-fact-resolve-mobile': memoryFactCase,
  'memory-ref-scope': memoryRefCase,
  'memory-ref-forget': memoryRefCase,
  'project-book-confirm': projectBookCase,
  'project-book-forget': projectBookCase,
  'project-book-restore': projectBookCase,
  'memory-pause': memoryRepairCase,
  'memory-diagnose': memoryRepairCase,
  'memory-connect': memoryRepairCase,
  'memory-repair': memoryRepairCase,
  'refresh-memory-status': async () => {
        // Reset cache so re-opening the panel forces a fresh collect.
        uiState.memoryStatus.loaded = false;
        await refreshMemoryStatus();
  },
  'memory-wipe-open': () => {
        uiState.memoryStatus.wipeConfirmOpen = true;
        uiState.memoryStatus.wipeResult = null;
        render();
  },
  'memory-wipe-cancel': () => {
        uiState.memoryStatus.wipeConfirmOpen = false;
        render();
  },
  'memory-wipe-confirm': async () => {
        await doWipeEmbeddings();
  },
};

// Form submits, formerly `case` branches of app.js's submit listener.
export const memoryForms = {
  'project-book-create': async ({ form }) => {
        await handleProjectBookAction('project-book-create', null, { form });
  },
};

// First branch of both app.js's 'input' and 'change' listeners (before the
// typing-guard stamp, as before the move). Returns true when it handled the event.
export function handleMemoryFactFieldInput(target) {
  if(target.id==='memory-fact-text'||target.id==='memory-fact-scope'||target.id==='memory-fact-category'||target.id==='memory-fact-pinned'){if(uiState.memoryFactDraft&&!uiState.memoryFactBusy){const field=target.id.replace('memory-fact-','');uiState.memoryFactDraft[field]=field==='pinned'?target.checked:target.value;memoryFactEdit.change();const button=document.querySelector('[data-action=memory-fact-save]');if(button){button.disabled=false;button.closest('.settings-edit-toolbar').dataset.editStatus='dirty';button.closest('.settings-edit-toolbar').querySelector('.settings-save-status').textContent=t("有未保存的修改");}}return true;}
  return false;
}

// 'input' listener branches that ran right after the typing-guard stamp.
export function handleMemoryInput(target) {
  if (target.dataset.memoryConnection) { uiState.memoryConnection ||= {}; uiState.memoryConnection[target.dataset.memoryConnection] = target.value; return true; }
  // Bug audit U7: capture the memory-book draft on every keystroke, not only on blur.
  if (target.form?.id === 'project-book-create' && target.name === 'text') { noteProjectBookDraft(target.form, { text: target.value }); return true; }
  return false;
}

// 'change' listener branches that ran right after the team-member toggle.
// Synchronous unless it handles the event: returns false (not ours), true
// (handled) or the pending save, which the listener awaits.
export function handleMemoryChange(target) {
  if (target.dataset?.bookSectionSelect) {
    const record = target.closest('[data-book-record]')?.dataset.bookRecord;
    if (record) { return handleProjectBookAction('project-book-section', record, { section: target.value }); }
    noteProjectBookDraft(target.closest('form[data-form="project-book-create"]'), { section: target.value }); return true;
  }
  if (target.closest?.('form[data-form="project-book-create"]') && target.name === 'text') { noteProjectBookDraft(target.closest('form'), { text: target.value }); return true; }
  return false;
}

export { handleMemoryRepairAction, handleMemoryFactAction, projectBookData, loadProjectBook, syncProjectDetailView, refreshProjectBook, noteProjectBookDraft, handleProjectBookAction, handleMemoryRefAction, refreshMemoryStatus, doWipeEmbeddings };
