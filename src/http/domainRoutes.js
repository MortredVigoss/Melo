import {previewChatDeletion,listChatFiles,decideChatFiles,openChatFiles} from '../services/workspace/chatWorkspaceFiles.js';
import { changeProjectLifecycle } from '../services/project/projectLifecycle.js';
import { createRouteRegistry } from './routeRegistry.js';
import { saveExtraFast, testExtraFast } from '../services/settings/extraFast.js';
import { memoryFacts, updateMemoryFact, projectMemoryBook, createProjectMemoryBookEntry } from '../services/memory/memoryManagement.js';
import { exportLocalArchive, importLocalArchive, validateLocalArchive, extractionCache } from '../services/settings/localData.js';
import { updateLocalProfile } from '../services/settings/localProfile.js';
import { listTaskOperations, releaseTaskOperation } from '../services/task/operationLedger.js';
import { listPermissionAudit } from '../safety/permissionAudit.js';
import { removeCommandRule } from '../safety/commandRules.js';
import { previewRestore, confirmRestore } from '../safety/restorePreview.js';
import { loadConfig, saveConfig, withConfigLock } from '../config.js';
import { normalizeLlmBaseUrl } from '../shared/llmProviders.js';
import { repairMemoryBatch, memoryRepairStatus, diagnoseMemory } from '../memory/repair.js';
import { saveLlmProfile, activateLlmProfile, forgetLlmProfile, testLlmProfile } from '../services/settings/llmConnections.js';
import { startOpenRouterOAuth, openRouterOAuthStatus } from '../providers/openRouterOAuth.js';
import { prepareTaskExecution } from '../services/task/prepareTaskExecution.js';
import { applyArtifactToWorkspaceFile, createCustomAgent, createArtifact, updateArtifact, deleteArtifact, restoreArtifact, createApproval, createExternalConnector, createProject, createTask, executeApproval, invokeExternalConnectorTool, pingExternalConnector, previewExternalConnectorPrompt, readExternalConnectorResource, rejectApproval, removeExternalConnector, runTask, runTaskLane, runLocalCommand, saveWorkspaceFile, selectWorkspaceFile, readWorkspaceFilePreview, createCustomSkill, updateCustomSkill, removeCustomSkill, exportSkillAsMarkdown, importSkillFromMarkdown, promoteSkillToDisk, reloadDiskSkills, scanRecentChatsForSkillProposals, applySkillProposal, draftSkillFromChat, toggleConnector, toggleSkill, testAgentChannelConnection, updateAgentProfile, updateTask, updateDesktopSettings, updateExternalConnector, updateModelConfig, updateProject, refreshModelCatalog } from '../desktopStore.js';
import { sendJson, readJsonBody } from './transport.js';
import { sendBootstrapAfterCommit } from './bootstrapAfterCommit.js';
import { startCodexOAuthLogin } from '../codexAuth.js';
import { defaultSkillProposalStore } from '../agents/skillProposals.js';
import { getSkillRunStats } from '../agents/skillRuns.js';
import { collectMemoryStatus, withLiveProviderModelId } from '../memory/status.js';
import { wipeEmbeddingsForDimChange, requireEmbeddingRepair } from '../memory/store.js';
import { getEmbeddingProvider } from '../memory/embedProviders/createEmbeddingProvider.js';


const router = createRouteRegistry([
    {method:'POST',paths:['/api/projects/lifecycle'],auth:'local-write',handler:async({request,response})=>sendBootstrapAfterCommit(response,await changeProjectLifecycle(await readJsonBody(request)))},
    {method:'POST',paths:['/api/chats/delete-preview'],auth:'local-write',handler:async({request,response})=>sendJson(response,200,await previewChatDeletion((await readJsonBody(request)).chatId))},
    {method:'GET',paths:['/api/workspace/retained'],auth:'local-read',handler:async({response})=>sendJson(response,200,await listChatFiles())},
    {method:'POST',paths:['/api/workspace/retained'],auth:'local-write',handler:async({request,response})=>sendJson(response,200,await decideChatFiles(await readJsonBody(request)))},
    {method:'POST',paths:['/api/workspace/open'],auth:'local-write',handler:async({request,response})=>sendJson(response,200,await openChatFiles(await readJsonBody(request)))},
    { method: 'POST', paths: ["/api/settings/extra-fast"], auth: 'local-write', handler: async ({ request, response, url, requireLocalOrigin }) => {
      sendJson(response, 200, await saveExtraFast(await readJsonBody(request))); return;
    } },
    { method: 'POST', paths: ["/api/settings/extra-fast/test"], auth: 'local-write', handler: async ({ request, response, url, requireLocalOrigin }) => {
      const abort = new AbortController();
      const closed = () => { if (!response.writableEnded) abort.abort(); };
      response.on('close', closed);
      try { sendJson(response, 200, await testExtraFast({ signal: abort.signal })); }
      finally { response.off('close', closed); }
      return;
    } },
    { method: 'GET', paths: ["/api/settings/export"], auth: 'local-read', handler: async ({ request, response, url, requireLocalOrigin }) => {
      const archive=await exportLocalArchive();
      if(url.searchParams.get('download')==='1') {
        response.writeHead(200,{'content-type':'application/json; charset=utf-8','content-disposition':'attachment; filename="Melo-workspace.json"','cache-control':'no-store'});
        response.end(JSON.stringify(archive,null,2));
      }else sendJson(response,200,archive);
      return;
    } },
    { method: 'GET', paths: ["/api/settings/cache"], auth: 'local-read', handler: async ({ request, response, url, requireLocalOrigin }) => { sendJson(response,200,await extractionCache());return; } },
    { method: 'POST', paths: ["/api/settings/cache/clear"], auth: 'local-write', handler: async ({ request, response, url, requireLocalOrigin }) => { sendJson(response,200,await extractionCache({clear:true}));return; } },
    { method: 'POST', paths: ["/api/settings/import-preview","/api/settings/import"], auth: 'local-write', handler: async ({ request, response, url, requireLocalOrigin }) => {
      const chunks=[];let size=0;
      for await (const chunk of request) {size+=chunk.length;if(size>16*1024*1024)throw new Error('资料文件超过 16 MB，请拆分后导入。');chunks.push(chunk);}
      const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));
      sendJson(response,200,url.pathname.endsWith('import-preview')?validateLocalArchive(body).summary:await importLocalArchive(body));return;
    } },

    { method: 'POST', paths: ["/api/settings/local"], auth: 'local-write', handler: async ({ request, response, url, requireLocalOrigin }) => { sendJson(response,200,await updateLocalProfile(await readJsonBody(request)));return; } },
    { method: 'GET', paths: ["/api/permissions/audit"], auth: 'local-read', handler: async ({ request, response, url, requireLocalOrigin }) => { sendJson(response,200,{events:listPermissionAudit(),commands:(await loadConfig()).commandPermissionRules || []}); return; } },
    { method: 'POST', paths: ["/api/permissions/command/remove"], auth: 'local-write', handler: async ({ request, response, url, requireLocalOrigin }) => { sendJson(response,200,await removeCommandRule((await readJsonBody(request)).id)); return; } },
    { method: 'POST', paths: ["/api/settings/llm/save","/api/settings/llm/activate","/api/settings/llm/remove","/api/settings/llm/test","/api/settings/llm/models","/api/settings/llm/oauth","/api/settings/llm/oauth/status"], auth: 'local-write', handler: async ({ request, response, url, requireLocalOrigin }) => {
      const body = await readJsonBody(request);
      const action = url.pathname.slice('/api/settings/llm/'.length);
      if (action === 'save') sendJson(response, 200, await saveLlmProfile(body));
      else if (action === 'activate') sendJson(response, 200, await activateLlmProfile(body.id));
      else if (action === 'remove') sendJson(response, 200, await forgetLlmProfile(body.id));
      else if (action === 'oauth') sendJson(response, 200, await startOpenRouterOAuth(body.id));
      else if (action === 'oauth/status') sendJson(response, 200, openRouterOAuthStatus(body.id, { cancel: body.cancel === true }));
      else {
        const abort = new AbortController();
        const closed = () => { if (!response.writableEnded) abort.abort(); };
        response.on('close', closed);
        try { sendJson(response, 200, await testLlmProfile(body.id, { signal: abort.signal, catalogOnly: action === 'models', modality: body.modality === 'vision' ? 'vision' : 'text' })); }
        finally { response.off('close', closed); }
      }
      return;
    } },

    { method: 'POST', paths: ["/api/projects"], auth: 'local-write', handler: async ({ request, response, url, requireLocalOrigin }) => {
      const body = await readJsonBody(request);
      await sendBootstrapAfterCommit(response, await createProject(body));
      return;
    } },

    { method: 'POST', paths: ["/api/projects/update"], auth: 'local-write', handler: async ({ request, response, url, requireLocalOrigin }) => {
      const body = await readJsonBody(request);
      await sendBootstrapAfterCommit(response, await updateProject(body.projectId, body.patch || {}));
      return;
    } },

    { method: 'POST', paths: ["/api/tasks/restore-preview"], auth: 'local-write', handler: async ({ request, response, url, requireLocalOrigin }) => { const body=await readJsonBody(request); sendJson(response,200,await previewRestore(body.operationId)); return; } },
    { method: 'POST', paths: ["/api/tasks/restore-confirm"], auth: 'local-write', handler: async ({ request, response, url, requireLocalOrigin }) => { const body=await readJsonBody(request); sendJson(response,200,await confirmRestore(body.token)); return; } },
    { method: 'GET', paths: ["/api/tasks/operations"], auth: 'local-read', handler: async ({ request, response, url, requireLocalOrigin }) => { sendJson(response,200,{operations:listTaskOperations(url.searchParams.get('taskId'))}); return; } },
    { method: 'POST', paths: ["/api/tasks/operations/retry"], auth: 'local-write', handler: async ({ request, response, url, requireLocalOrigin }) => {const body=await readJsonBody(request);if(body.confirm!=='verified-not-applied') throw new Error('请先核对操作没有产生效果。');sendJson(response,200,releaseTaskOperation(body.taskId,body.key));return;} },
    { method: 'POST', paths: ["/api/tasks/pricing"], auth: 'local-write', handler: async ({ request, response, url, requireLocalOrigin }) => {
      const body=await readJsonBody(request);
      if (['input','output','cached','cacheWrite'].some(k=>body[k] == null || String(body[k]).trim()==='')) throw new Error('请填写全部四项单价；未知时保持未配置。');
      const rates=Object.fromEntries(['input','output','cached','cacheWrite'].map(k=>[k,Number(body[k])]));
      if(Object.values(rates).some(v=>!Number.isFinite(v) || v<0)) throw new Error('请输入有效单价。');
      await withConfigLock(async()=>{const config=await loadConfig();await saveConfig({...config,modelPricing:{...config.modelPricing,[config.model]:rates}});});
      sendJson(response,200,{ok:true});return;
    } },
    { method: 'POST', paths: ["/api/tasks"], auth: 'local-write', handler: async ({ request, response, url, requireLocalOrigin }) => {
      const body = await readJsonBody(request);
      sendJson(response, 200, await createTask(body));
      return;
    } },

    { method: 'POST', paths: ["/api/tasks/update"], auth: 'local-write', handler: async ({ request, response, url, requireLocalOrigin }) => {
      const body = await readJsonBody(request);
      sendJson(response, 200, await updateTask(body.taskId, body.patch || {}));
      return;
    } },

    { method: 'POST', paths: ["/api/tasks/prepare"], auth: 'local-write', handler: async ({ request, response, url, requireLocalOrigin }) => {
      const body = await readJsonBody(request);
      sendJson(response, 200, await prepareTaskExecution(body.taskId, {teamPlan:body.teamPlan}));
      return;
    } },

    { method: 'POST', paths: ["/api/tasks/run"], auth: 'local-write', handler: async ({ request, response, url, requireLocalOrigin }) => {
      const body = await readJsonBody(request);
      sendJson(response, 200, await runTask(body.taskId));
      return;
    } },

    { method: 'POST', paths: ["/api/tasks/run-lane"], auth: 'local-write', handler: async ({ request, response, url, requireLocalOrigin }) => {
      const body = await readJsonBody(request);
      sendJson(response, 200, await runTaskLane(body.owner));
      return;
    } },

    { method: 'POST', paths: ["/api/approvals"], auth: 'local-write', handler: async ({ request, response, url, requireLocalOrigin }) => {
      const body = await readJsonBody(request);
      sendJson(response, 200, await createApproval(body));
      return;
    } },

    { method: 'POST', paths: ["/api/approvals/execute"], auth: 'local-write', handler: async ({ request, response, url, requireLocalOrigin }) => {
      const body = await readJsonBody(request);
      sendJson(response, 200, await executeApproval(body.approvalId));
      return;
    } },

    { method: 'POST', paths: ["/api/approvals/reject"], auth: 'local-write', handler: async ({ request, response, url, requireLocalOrigin }) => {
      const body = await readJsonBody(request);
      sendJson(response, 200, await rejectApproval(body.approvalId));
      return;
    } },

    { method: 'POST', paths: ["/api/connectors/external"], auth: 'local-write', handler: async ({ request, response, url, requireLocalOrigin }) => {
      const body = await readJsonBody(request);
      sendJson(response, 200, await createExternalConnector(body));
      return;
    } },

    { method: 'POST', paths: ["/api/connectors/external/update"], auth: 'local-write', handler: async ({ request, response, url, requireLocalOrigin }) => {
      const body = await readJsonBody(request);
      sendJson(response, 200, await updateExternalConnector(body.connectorId, body.patch || {}));
      return;
    } },

    { method: 'POST', paths: ["/api/connectors/external/remove"], auth: 'local-write', handler: async ({ request, response, url, requireLocalOrigin }) => {
      const body = await readJsonBody(request);
      sendJson(response, 200, await removeExternalConnector(body.connectorId));
      return;
    } },

    { method: 'POST', paths: ["/api/connectors/external/ping"], auth: 'local-write', handler: async ({ request, response, url, requireLocalOrigin }) => {
      const body = await readJsonBody(request);
      sendJson(response, 200, await pingExternalConnector(body.connectorId));
      return;
    } },

    { method: 'POST', paths: ["/api/connectors/external/resource"], auth: 'local-write', handler: async ({ request, response, url, requireLocalOrigin }) => {
      const body = await readJsonBody(request);
      sendJson(response, 200, await readExternalConnectorResource(body));
      return;
    } },

    { method: 'POST', paths: ["/api/connectors/external/prompt"], auth: 'local-write', handler: async ({ request, response, url, requireLocalOrigin }) => {
      const body = await readJsonBody(request);
      sendJson(response, 200, await previewExternalConnectorPrompt(body));
      return;
    } },

    { method: 'POST', paths: ["/api/connectors/external/invoke"], auth: 'local-write', handler: async ({ request, response, url, requireLocalOrigin }) => {
      const body = await readJsonBody(request);
      sendJson(response, 200, await invokeExternalConnectorTool(body));
      return;
    } },

    { method: 'POST', paths: ["/api/workspace/select-file"], auth: 'local-write', handler: async ({ request, response, url, requireLocalOrigin }) => {
      const body = await readJsonBody(request);
      sendJson(response, 200, await selectWorkspaceFile(body.filePath,body.chatId));
      return;
    } },

    { method: 'POST', paths: ["/api/workspace/save-file"], auth: 'local-write', handler: async ({ request, response, url, requireLocalOrigin }) => {
      sendJson(response,410,{error:"This direct action endpoint is retired. Create and execute an approval instead.",code:"APPROVAL_REQUIRED"});
    } },

    // Read-only workspace-file preview for the citation side viewer.
    // Unlike select-file, this does NOT mutate state; it just returns the
    // file contents so the UI can render them in the source drawer beside
    // the chat. Path traversal / absolute paths are rejected by the
    // underlying workspace-file service, so only files inside the active
    // project's workspacePath can be read.
    { method: 'POST', paths: ["/api/workspace/citation-preview"], auth: 'local-write', handler: async ({ request, response, url, requireLocalOrigin }) => {
      const body = await readJsonBody(request);
      sendJson(response, 200, await readWorkspaceFilePreview(body));
      return;
    } },

    { method: 'POST', paths: ["/api/artifacts"], auth: 'local-write', handler: async ({ request, response, url, requireLocalOrigin }) => {
      const body = await readJsonBody(request);
      sendJson(response, 200, await createArtifact(body));
      return;
    } },

    { method: 'POST', paths: ["/api/artifacts/apply"], auth: 'local-write', handler: async ({ request, response, url, requireLocalOrigin }) => {
      sendJson(response,410,{error:"This direct action endpoint is retired. Create and execute an approval instead.",code:"APPROVAL_REQUIRED"});
    } },

    { method: 'POST', paths: ["/api/artifacts/update"], auth: 'local-write', handler: async ({ request, response, url, requireLocalOrigin }) => {
      const body = await readJsonBody(request);
      sendJson(response, 200, await updateArtifact(body?.artifactId, body?.patch || {}));
      return;
    } },

    { method: 'POST', paths: ["/api/artifacts/delete"], auth: 'local-write', handler: async ({ request, response, url, requireLocalOrigin }) => {
      const body = await readJsonBody(request);
      sendJson(response, 200, await deleteArtifact(body?.artifactId));
      return;
    } },

    { method: 'POST', paths: ["/api/artifacts/restore"], auth: 'local-write', handler: async ({ request, response, url, requireLocalOrigin }) => {
      const body = await readJsonBody(request);
      sendJson(response, 200, await restoreArtifact(body?.artifactId));
      return;
    } },

    { method: 'POST', paths: ["/api/command/run"], auth: 'local-write', handler: async ({ request, response, url, requireLocalOrigin }) => {
      sendJson(response,410,{error:"This direct action endpoint is retired. Create and execute an approval instead.",code:"APPROVAL_REQUIRED"});
    } },

    { method: 'POST', paths: ["/api/settings"], auth: 'local-write', handler: async ({ request, response, url, requireLocalOrigin }) => {
      const body = await readJsonBody(request);
      sendJson(response, 200, await updateDesktopSettings(body));
      return;
    } },

    { method: 'POST', paths: ["/api/settings/model"], auth: 'local-write', handler: async ({ request, response, url, requireLocalOrigin }) => {
      const body = await readJsonBody(request);
      sendJson(response, 200, await updateModelConfig(body));
      return;
    } },

    { method: 'POST', paths: ["/api/settings/model/options"], auth: 'local-write', handler: async ({ request, response, url, requireLocalOrigin }) => {
      const body = await readJsonBody(request);
      sendJson(response, 200, await refreshModelCatalog(body));
      return;
    } },

    { method: 'POST', paths: ["/api/settings/model/oauth/start"], auth: 'local-write', handler: async ({ request, response, url, requireLocalOrigin }) => {
      sendJson(response, 200, await startCodexOAuthLogin());
      return;
    } },

    { method: 'POST', paths: ["/api/customize/skill-toggle"], auth: 'local-write', handler: async ({ request, response, url, requireLocalOrigin }) => {
      if (!requireLocalOrigin(request, response)) return;
      const body = await readJsonBody(request);
      sendJson(response, 200, await toggleSkill(body.skillId));
      return;
    } },

    { method: 'POST', paths: ["/api/customize/connector-toggle"], auth: 'local-write', handler: async ({ request, response, url, requireLocalOrigin }) => {
      if (!requireLocalOrigin(request, response)) return;
      const body = await readJsonBody(request);
      sendJson(response, 200, await toggleConnector(body.connectorId));
      return;
    } },

    { method: 'POST', paths: ["/api/skills/custom"], auth: 'local-write', handler: async ({ request, response, url, requireLocalOrigin }) => {
      if (!requireLocalOrigin(request, response)) return;
      const body = await readJsonBody(request);
      sendJson(response, 200, await createCustomSkill(body.skill));
      return;
    } },

    { method: 'POST', paths: ["/api/skills/custom/update"], auth: 'local-write', handler: async ({ request, response, url, requireLocalOrigin }) => {
      if (!requireLocalOrigin(request, response)) return;
      const body = await readJsonBody(request);
      sendJson(response, 200, await updateCustomSkill(body.skillId, body.patch));
      return;
    } },

    { method: 'POST', paths: ["/api/skills/custom/remove"], auth: 'local-write', handler: async ({ request, response, url, requireLocalOrigin }) => {
      if (!requireLocalOrigin(request, response)) return;
      const body = await readJsonBody(request);
      sendJson(response, 200, await removeCustomSkill(body.skillId));
      return;
    } },

    // Phase 5C — UI entry point for "Save chat as skill".
    // The body is `{ chatId, hint? }`. The response is the `{ ok, skill?, error?,
    // reason?, raw? }` envelope from draftSkillFromConversation. We never
    // auto-persist the drafted skill — the UI pre-fills the create-skill form
    // with it and the user confirms manually, mirroring the REPL flow.
    { method: 'POST', paths: ["/api/skills/draft-from-chat"], auth: 'local-write', handler: async ({ request, response, url, requireLocalOrigin }) => {
      if (!requireLocalOrigin(request, response)) return;
      const body = await readJsonBody(request);
      const result = await draftSkillFromChat(String(body?.chatId || ''), {
        hint: String(body?.hint || ''),
      });
      sendJson(response, 200, result);
      return;
    } },

    // Phase 3.1.3 — export a skill (built-in or custom) as SKILL.md. GET-only,
    // query-string driven so it's trivial to hit from the browser or a curl
    // debug script: /api/skills/export?id=<skillId>. Body is JSON
    // {id, markdown} to keep UI parsing symmetric with import.
    { method: 'GET', paths: ["/api/skills/export"], auth: 'local-read', handler: async ({ request, response, url, requireLocalOrigin }) => {
      const id = url.searchParams.get('id') || '';
      if (!id) {
        sendJson(response, 400, { error: 'missing ?id= query parameter' });
        return;
      }
      try {
        const result = await exportSkillAsMarkdown(id);
        sendJson(response, 200, result);
      } catch (err) {
        sendJson(response, 404, { error: err.message });
      }
      return;
    } },

    // Phase 3.1.3 — import a skill from SKILL.md text. Body:
    //   { markdown: "---\nname: …\n---\n…", writeToDisk?: bool, idOverride?: string }
    // Returns the refreshed bootstrap envelope on success.
    { method: 'POST', paths: ["/api/skills/import"], auth: 'local-write', handler: async ({ request, response, url, requireLocalOrigin }) => {
      if (!requireLocalOrigin(request, response)) return;
      const body = await readJsonBody(request);
      try {
        const bootstrap = await importSkillFromMarkdown(String(body?.markdown || ''), {
          writeToDisk: Boolean(body?.writeToDisk),
          idOverride: body?.idOverride ? String(body.idOverride) : null,
        });
        sendJson(response, 200, bootstrap);
      } catch (err) {
        sendJson(response, 400, { error: err.message });
      }
      return;
    } },

    // Phase 3.1.3 — promote a JSON-only custom skill to disk (mirrors it to
    // ~/.melo/desktop/skills/<id>/SKILL.md and flips origin).
    { method: 'POST', paths: ["/api/skills/promote-to-disk"], auth: 'local-write', handler: async ({ request, response, url, requireLocalOrigin }) => {
      if (!requireLocalOrigin(request, response)) return;
      const body = await readJsonBody(request);
      try {
        const bootstrap = await promoteSkillToDisk(String(body?.skillId || ''));
        sendJson(response, 200, bootstrap);
      } catch (err) {
        sendJson(response, 400, { error: err.message });
      }
      return;
    } },

    // Phase 3.1.3 — force-reload disk skills after the user manually edited a
    // SKILL.md on disk. UI exposes this as a "Refresh from disk" button in
    // Customize → Skills.
    { method: 'POST', paths: ["/api/skills/reload-disk"], auth: 'local-write', handler: async ({ request, response, url, requireLocalOrigin }) => {
      if (!requireLocalOrigin(request, response)) return;
      try {
        const bootstrap = await reloadDiskSkills();
        sendJson(response, 200, bootstrap);
      } catch (err) {
        sendJson(response, 500, { error: err.message });
      }
      return;
    } },

    // Phase 3.3.4 — skill-run telemetry for the health panel. Read-only,
    // local-only server so no Origin gate is required.
    { method: 'GET', paths: ["/api/skills/runs/stats"], auth: 'local-read', handler: async ({ request, response, url, requireLocalOrigin }) => {
      try {
        const skillId = url.searchParams.get('skillId') || undefined;
        const windowDaysRaw = url.searchParams.get('windowDays');
        const windowDays = windowDaysRaw && !isNaN(Number(windowDaysRaw))
          ? Number(windowDaysRaw)
          : undefined;
        const stats = getSkillRunStats({ skillId, windowDays });
        sendJson(response, 200, stats);
      } catch (err) {
        sendJson(response, 500, { error: err.message });
      }
      return;
    } },

    // Phase 3 — memory subsystem status for the Customize → Memory panel.
    // Pure read-only: collectMemoryStatus opens store.sqlite read-only, never
    // touches state.json or _meta.  Safe to poll from the UI without any
    // rate-limiting.  If an embedding provider is currently configured we
    // also check for modelId drift so the UI can flash a warning chip.
    { method: 'GET', paths: ["/api/memory/facts"], auth: 'local-read', handler: async ({ request, response, url, requireLocalOrigin }) => { sendJson(response,200,await memoryFacts({query:url.searchParams.get('q'),offset:url.searchParams.get('offset')})); return; } },
    { method: 'POST', paths: ["/api/memory/facts/update"], auth: 'local-write', handler: async ({ request, response, url, requireLocalOrigin }) => { if (!requireLocalOrigin(request,response)) return; sendJson(response,200,await updateMemoryFact(await readJsonBody(request))); return; } },
    // Project memory book (design 2B): list for the project page; hand-written rows.
    { method: 'GET', paths: ["/api/projects/memory-book"], auth: 'local-read', handler: async ({ request, response, url, requireLocalOrigin }) => { sendJson(response,200,await projectMemoryBook({projectId:url.searchParams.get('projectId')})); return; } },
    { method: 'POST', paths: ["/api/projects/memory-book"], auth: 'local-write', handler: async ({ request, response, url, requireLocalOrigin }) => { if (!requireLocalOrigin(request,response)) return; sendJson(response,200,await createProjectMemoryBookEntry(await readJsonBody(request))); return; } },
    { method: 'POST', paths: ["/api/memory/repair"], auth: 'local-write', handler: async ({ request, response, url, requireLocalOrigin }) => {
      sendJson(response, 200, await repairMemoryBatch()); return;
    } },
    { method: 'GET', paths: ["/api/memory/diagnose"], auth: 'local-read', handler: async ({ request, response, url, requireLocalOrigin }) => {
      sendJson(response, 200, await diagnoseMemory(collectMemoryStatus())); return;
    } },
    { method: 'POST', paths: ["/api/memory/connect"], auth: 'local-write', handler: async ({ request, response, url, requireLocalOrigin }) => {
      const body = await readJsonBody(request);
      if (body.provider && body.provider !== 'builtin') throw new Error('本地记忆使用 Melo 内置模型。');
      await withConfigLock(async () => {
        const config = await loadConfig();
        await saveConfig({ ...config, embeddingConnection: { provider: 'builtin' } });
      });
      sendJson(response, 200, await diagnoseMemory(collectMemoryStatus())); return;
    } },
    { method: 'GET', paths: ["/api/memory/status"], auth: 'local-read', handler: async ({ request, response, url, requireLocalOrigin }) => {
      try {
        const base = collectMemoryStatus();
        let providerModelId = null;
        try {
          const embedder = await getEmbeddingProvider();
          providerModelId = embedder?.modelId || null;
        } catch {
          // Provider init failure is non-fatal for the status view — the
          // snapshot still shows stored state, just without the live check.
        }
        const connection = (await loadConfig()).embeddingConnection;
        sendJson(response, 200, { ...withLiveProviderModelId(base, providerModelId), repair: memoryRepairStatus(), connection: connection?.provider === 'ollama' ? { baseUrl: connection.baseUrl, model: connection.model } : null });
      } catch (err) {
        sendJson(response, 500, { error: err?.message || String(err) });
      }
      return;
    } },

    // Phase 3 — explicit destructive action: wipe every stored embedding so
    // the next embed pass repopulates from the current provider's vector
    // space.  Requires an explicit `{ confirm: "YES, WIPE EMBEDDINGS" }`
    // body token — the UI must show a confirmation dialog before sending.
    // Memory rows themselves are untouched; only the `embedding` column is
    // cleared and vec_memories is dropped + rebuilt on next write.
    // Rule 5 (preserve config): this endpoint does NOT touch state.json,
    // agent profiles, channel tokens, or any user-configured secret.
    { method: 'POST', paths: ["/api/memory/wipe-embeddings"], auth: 'local-write', handler: async ({ request, response, url, requireLocalOrigin }) => {
      if (!requireLocalOrigin(request, response)) return;
      const body = await readJsonBody(request);
      if (String(body?.confirm || '') !== 'YES, WIPE EMBEDDINGS') {
        sendJson(response, 400, {
          error: 'missing or invalid confirm token',
          expected: 'YES, WIPE EMBEDDINGS',
        });
        return;
      }
      try {
        let dims = Number(body?.dims);
        if (!Number.isFinite(dims) || dims <= 0) {
          // Fall back to whatever the provider reports, else the canonical.
          try {
            const embedder = await getEmbeddingProvider();
            dims = Number(embedder?.dims) || 1024;
          } catch {
            dims = 1024;
          }
        }
        const cleared = wipeEmbeddingsForDimChange(dims);
        sendJson(response, 200, { cleared, dims });
      } catch (err) {
        sendJson(response, 500, { error: err?.message || String(err) });
      }
      return;
    } },

    // Read-only listing of background-clustered skill proposals (Phase 3D).
    // GET is safe — no Origin gate — but the route still only binds to
    // 127.0.0.1 by the server default.
    { method: 'GET', paths: ["/api/skill-proposals"], auth: 'local-read', handler: async ({ request, response, url, requireLocalOrigin }) => {
      sendJson(response, 200, { proposals: defaultSkillProposalStore.list() });
      return;
    } },

    { method: 'POST', paths: ["/api/skill-proposals/dismiss"], auth: 'local-write', handler: async ({ request, response, url, requireLocalOrigin }) => {
      if (!requireLocalOrigin(request, response)) return;
      const body = await readJsonBody(request);
      const dismissed = defaultSkillProposalStore.dismiss(body.seedId);
      sendJson(response, 200, { dismissed });
      return;
    } },

    // Phase 3.4.1 — manual rescan trigger. The scan also fires
    // automatically after each assistant turn; this endpoint lets the UI
    // force one (e.g. after importing chats from another device).
    { method: 'POST', paths: ["/api/skill-proposals/rescan"], auth: 'local-write', handler: async ({ request, response, url, requireLocalOrigin }) => {
      if (!requireLocalOrigin(request, response)) return;
      try {
        const result = await scanRecentChatsForSkillProposals();
        sendJson(response, 200, {
          ...result,
          proposals: defaultSkillProposalStore.list(),
        });
      } catch (err) {
        sendJson(response, 500, { error: err.message });
      }
      return;
    } },

    // Phase 3.4.2 — apply an upgrade proposal. The UI calls this after the
    // user approves an upgrade card: it merges the proposed triggers into
    // the target skill, appends the systemPrompt appendix, and writes the
    // reference file. Create-kind proposals still go through the separate
    // skill-drafting flow.
    { method: 'POST', id: '/api/skill-proposals/:seedId/apply', match: url => url.pathname.startsWith('/api/skill-proposals/') && url.pathname.endsWith('/apply'), auth: 'local-write', handler: async ({ request, response, url, requireLocalOrigin }) => {
      if (!requireLocalOrigin(request, response)) return;
      const seedId = decodeURIComponent(
        url.pathname.slice('/api/skill-proposals/'.length, -'/apply'.length),
      );
      try {
        const result = await applySkillProposal(seedId);
        if (result?.ok) {
          sendJson(response, 200, result);
        } else {
          const status = result?.error === 'NOT_FOUND' ? 404
            : result?.error === 'BAD_SEED_ID' ? 400
            : result?.error === 'UNSUPPORTED_KIND' ? 400
            : result?.error === 'BUILTIN_TARGET' ? 400
            : result?.error === 'BUNDLED_TARGET' ? 403
            : result?.error === 'TARGET_MISSING' ? 404
            : result?.error === 'NO_STATE' ? 500
            : 400;
          sendJson(response, status, result || { ok: false, error: 'UNKNOWN' });
        }
      } catch (err) {
        sendJson(response, 500, { ok: false, error: 'INTERNAL', reason: err.message });
      }
      return;
    } },

    { method: 'POST', paths: ["/api/agents/update"], auth: 'local-write', handler: async ({ request, response, url, requireLocalOrigin }) => {
      const body = await readJsonBody(request);
      await sendBootstrapAfterCommit(
        response,
        await updateAgentProfile(body.agentId, body.patch || {}, {
          scope: body.scope,
          projectId: body.projectId,
          clearProjectOverride: Boolean(body.clearProjectOverride),
          activeView: body.activeView,
        }),
      );
      return;
    } },

    { method: 'POST', paths: ["/api/agents/create-custom"], auth: 'local-write', handler: async ({ request, response, url, requireLocalOrigin }) => {
      // Capability elevation rule 6: the read-only starter set, or "基于已有 Agent".
      const body = await readJsonBody(request, { maxBytes: 4096 });
      if ((body.basedOn != null && typeof body.basedOn !== 'string') || (body.copyPersona !== undefined && typeof body.copyPersona !== 'boolean')) {
        sendJson(response, 400, { ok: false, error: 'basedOn must be an Agent id and copyPersona a boolean.' });
        return;
      }
      await sendBootstrapAfterCommit(response, await createCustomAgent({ basedOn: body.basedOn ?? null, copyPersona: body.copyPersona === true }));
      return;
    } },

    { method: 'POST', paths: ["/api/agents/channel/test"], auth: 'local-write', handler: async ({ request, response, url, requireLocalOrigin }) => {
      const body = await readJsonBody(request);
      await sendBootstrapAfterCommit(
        response,
        await testAgentChannelConnection(
          body.agentId,
          body.channelId,
          body.patch || {},
          {
            scope: body.scope,
            projectId: body.projectId,
          },
        ),
      );
      return;
    } },
]);
export const domainRouteInventory = router.inventory;
export const matchesDomainRoute = router.matches;
export const handleDomainRoutes = router.handle;

