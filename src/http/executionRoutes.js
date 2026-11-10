import { findArchivedRun, listArchivedRuns } from '../persistence/turnArchive.js';
import { loadState } from '../state/stateStore.js';
import { readExecutionScene, selectSceneImage, saveExecutionScene, executionSearchContext } from '../services/chat/executionScenes.js';
import { TOOL_TRACE_PREFIX } from '../services/chat/toolTraceReplay.js';
import { sendJson, readJsonBody } from './transport.js';

// Same local-origin protection as the other chat routes. No execution API is
// called when inspecting history or changing an already-generated selection.
const selections = new Map();
const compare = (a, b) => a === b ? 0 : a < b ? -1 : 1;
// A `[工具轨迹]` record lists the calls of a stopped run, URLs included. It is not the run's
// answer: taken as one, every URL it lists came back as "cited by the answer" after a reload.
// (A trace synced from the phone has no kind and is recognised by the shared prefix.)
export const isRunAnswer = message => message?.role === 'assistant' && message.kind !== 'tool-trace' && !String(message.content || '').startsWith(TOOL_TRACE_PREFIX);
// The answer of one run among a chat's messages: its last reply that is not a trace, or none.
export const runAnswer = (messages, runId) => (messages || []).findLast(message => isRunAnswer(message) && message.metadata?.runId === runId);
export async function handleExecutionRoutes(request, response, url, home) {
  if (!['/api/chat/scenes', '/api/chat/scenes/select-image'].includes(url.pathname)) return false;
  if (url.pathname === '/api/chat/scenes' && request.method === 'GET') {
    const state = await loadState({ home });
    const chatId = url.searchParams.get('chatId');
    const chat = state.chats.find(chat => chat.id === chatId);
    if (!chat) { sendJson(response, 404, { error: 'Chat not found' }); return true; }
    const requestedRun = url.searchParams.get('runId');
    let before;
    try { if (url.searchParams.has('before')) {
      before = JSON.parse(Buffer.from(url.searchParams.get('before'), 'base64url').toString());
      if (typeof before.createdAt !== 'string' || typeof before.runId !== 'string') throw new Error();
    } } catch { sendJson(response, 400, { error: 'Invalid history cursor' }); return true; }
    const limit = 20;
    const archived = requestedRun ? [findArchivedRun(home, chatId, { runId: requestedRun })].filter(Boolean)
      : listArchivedRuns(home, chatId, { before, limit: limit + 1 });
    const candidates = new Map(archived.map(run => [run.runId, run]));
    for (const run of state.chatRuns || []) if (run.chatId === chatId) candidates.set(run.runId, run);
    const assistants = new Map(), users = new Map(), synced = new Map();
    for (const [index, message] of chat.messages.entries()) {
      const scene = message.metadata?.syncedExecutionScene;
      const runId = message.metadata?.runId || scene?.runId;
      if (!runId) continue;
      if (isRunAnswer(message)) assistants.set(runId, message);
      if (message.role === 'user') users.set(runId, index);
      if (scene) synced.set(runId, scene);
      if (!candidates.has(runId) && (scene || requestedRun === runId)) candidates.set(runId, { runId, createdAt: scene?.startedAt || message.createdAt || '' });
    }
    const ordered = [...candidates.values()].filter(run => requestedRun ? run.runId === requestedRun
      : !before || run.createdAt < before.createdAt || (run.createdAt === before.createdAt && run.runId < before.runId))
      .sort((a, b) => compare(String(b.createdAt), String(a.createdAt)) || compare(b.runId, a.runId));
    const runs = ordered.slice(0, requestedRun ? 1 : limit);
    const scenes = (await Promise.all(runs.map(async run => {
      const index = users.get(run.runId);
      return await readExecutionScene(home, run.runId, { message: assistants.get(run.runId),
        searchContext: index == null ? '' : executionSearchContext(chat.messages.slice(0, index), chat.messages[index].content),
      }) || synced.get(run.runId);
    }))).filter(Boolean);
    const last = runs.at(-1);
    const nextCursor = !requestedRun && ordered.length > limit ? Buffer.from(JSON.stringify({ createdAt: last.createdAt, runId: last.runId })).toString('base64url') : null;
    sendJson(response, 200, { scenes, nextCursor });
    return true;
  }
  if (url.pathname.endsWith('/select-image') && request.method === 'POST') {
    const body = await readJsonBody(request);
    const state = await loadState({ home });
    if (!state.chats.some(chat => chat.id === body.chatId) || !(state.chatRuns?.some(run => run.runId === body.runId && run.chatId === body.chatId) || findArchivedRun(home, body.chatId, { runId: body.runId }))) {
      sendJson(response, 404, { error: 'Run not found' }); return true;
    }
    const key = `${home}\0${body.runId}`;
    const next = (selections.get(key) || Promise.resolve()).catch(() => {}).then(async () => {
      const messages = state.chats.find(chat => chat.id === body.chatId)?.messages || [];
      const index = messages.findIndex(m => m.role === 'user' && m.metadata?.runId === body.runId);
      const scene = await readExecutionScene(home, body.runId, {
        // The same rule as the listing above: choosing an image of a stopped run used to save
        // its scene with every URL of the trace marked as cited.
        message: runAnswer(messages, body.runId),
        searchContext: index < 0 ? '' : executionSearchContext(messages.slice(0, index), messages[index].content),
      });
      if (!scene) throw Object.assign(new Error('Scene not found'), { statusCode: 404 });
      selectSceneImage(scene, body.artifactId, body.slot);
      await saveExecutionScene(home, scene);
      return scene;
    });
    selections.set(key, next);
    try { sendJson(response, 200, { scene: await next }); }
    finally { if (selections.get(key) === next) selections.delete(key); }
    return true;
  }
  sendJson(response, 405, { error: 'Method not allowed' });
  return true;
}
