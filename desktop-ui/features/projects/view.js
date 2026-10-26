// Projects page renderers (architecture plan P2, 2026-10-19). Moved out of
// desktop-ui/app.js byte-for-byte first; they now read the feature's own
// state and reach the bootstrap and the memory book through the context.
import { t, ui } from '../../i18n.js';
import { conversationAgents } from '../../modelPresentation.js';
import { renderTeamPanel } from '../../teamPanel.js';
import { getBootstrap, activeProject, activeProjectChats, activeProjectArtifacts, renderMemoryBook, escapeHtml, truncate, icon } from './context.js';
import { projectsState } from './state.js';
import { filteredProjects } from './controller.js';

// Projects page is a two-mode view:
//
// - Overview: Claude-style grid of project cards (or a full empty state with
//   a single CTA when there are zero projects). Search + "New project"
//   sit in a tidy top bar.
// - Detail: opens when a card is clicked (selectedProjectId is set). Shows a
//   back button, an edit form, related chats, and artifacts.
//
// There's no split "list-on-left, detail-on-right" split anymore — clicking
// a card navigates into the detail, and a Back button returns to the grid.
function renderProjectsPage() {
  const project = activeProject();
  if (project) {
    return renderProjectsDetailView(project);
  }
  return renderProjectsOverview();
}

function renderProjectsOverview() {
  const projects = filteredProjects();
  const totalProjects = getBootstrap()?.projects?.length || 0;
  const searchActive = projectsState.projectSearch.trim().length > 0;

  const createForm = projectsState.showProjectForm ? renderProjectCreateForm() : '';

  // Zero projects + no active form → full empty state with a primary CTA.
  if (totalProjects === 0 && !projectsState.showProjectForm) {
    return ui`
      <section class="page">
        <div class="page-grid">
          <div class="header-row">
            <div>
              <h1 class="page-title compact">项目</h1>
              <p class="page-kicker">把同一目标下的对话、知识与工作要求放在一起。</p>
            </div>
          </div>

          <div class="surface-card project-empty-hero">
            <div class="project-empty-hero__icon">${icon.folder}</div>
            <h2 class="pane-title project-empty-hero__title">还没有项目</h2>
            <p class="project-empty-hero__body">
              为一件持续进行的事创建项目，写下目标与要求，再把相关对话放进来。每次继续对话都会带上项目背景。
            </p>
            <button class="ghost-button is-primary" data-action="toggle-project-form">
              <span class="toolbar-icon">${icon.plus}</span>
              创建第一个项目
            </button>
          </div>
        </div>
      </section>
    `;
  }

  return ui`
    <section class="page">
      <div class="page-grid">
        <div class="header-row project-overview-header">
          <div>
            <h1 class="page-title compact">项目</h1>
            <p class="page-kicker">${totalProjects} 个项目</p>
          </div>

          <div class="inline-actions">
            <button class="ghost-button" data-action="toggle-archived-projects">${t(projectsState.showArchivedProjects?'查看进行中的项目':'查看已归档项目')}</button>
            <button class="ghost-button" data-action="toggle-deleted-projects">${t(projectsState.showDeletedProjects?'返回项目':'已删除项目')}</button>
            <button class="ghost-button is-primary" data-action="toggle-project-form">
              <span class="toolbar-icon">${icon.plus}</span>
              新建项目
            </button>
          </div>
        </div>

        ${createForm}

        <div class="surface-card project-search-card">
          <div class="search-row">
            <input
              class="search-input"
              id="project-search"
              type="search"
              value="${escapeHtml(projectsState.projectSearch)}"
              placeholder="搜索项目…"
            />
          </div>
        </div>

        ${
          projects.length
            ? ui`
              <div class="project-grid">
                ${projects.map(renderProjectCard).join('')}
              </div>
            `
            : ui`
              <div class="surface-card empty-state compact">
                ${
                  searchActive
                    ? `没有匹配“${escapeHtml(projectsState.projectSearch)}”的项目。`
                    : '还没有项目，先创建一个目标。'
                }
              </div>
            `
        }
      </div>
    </section>
  `;
}

function renderProjectCard(item) {
  if (item.deletedAt) return ui`<section class="project-card">
    <h2 class="pane-title">${escapeHtml(item.nameKey ? t(item.nameKey) : item.name)}</h2><p>项目已删除；对话、知识、图片和原文件夹保留。</p>
    <p>原项目记忆保留在旧范围，旧审批不会恢复。</p>
    <button class="small-button" data-action="restore-deleted-project" data-project-id="${escapeHtml(item.id)}" ${projectsState.lifecycleBusy?'disabled':''}>恢复为新项目</button>
  </section>`;
  // A single project card in the overview grid. Clicking anywhere on the
  // card opens the detail view. Action buttons (开启项目对话 / 处理项目代码)
  // stop propagation so they don't also trigger the card click.
  return ui`
    <button
      class="project-card"
      data-action="focus-project"
      data-project-id="${item.id}"
    >
      <div class="project-card__header">
        <span class="chip is-accent">${escapeHtml(item.tag)}</span>
        <span class="meta-label">${escapeHtml(item.updatedLabel)}</span>
      </div>
      <div class="project-card__title">${escapeHtml(item.name)}</div>
      <div class="project-card__summary">${escapeHtml(item.summary)}</div>
      <div class="project-card__footer">
        <span class="project-card__metric">
          <span class="toolbar-icon">${icon.bubble}</span>
          ${item.chatCount} 段对话
        </span>
        <span class="project-card__metric">
          <span class="toolbar-icon">${icon.box}</span>
          ${item.artifactCount} 份知识与成果
        </span>
      </div>
    </button>
  `;
}

function renderProjectCreateForm() {
  return ui`
    <form class="project-form-card surface-card" data-form="project-create">
      <div class="project-form-grid">
        <label class="label">
          项目名称
          <input ${projectsState.projectCreating ? 'disabled' : ''} class="input" name="name" value="${escapeHtml(
            projectsState.draftProject.name,
          )}" placeholder="例如：旅行规划、产品开发" />
        </label>
        <label class="label">
          分类
          <input ${projectsState.projectCreating ? 'disabled' : ''} class="input" name="tag" value="${escapeHtml(
            projectsState.draftProject.tag,
          )}" placeholder="例如：生活、工作" />
        </label>
      </div>

      <label class="label">
        项目文件夹
        <input ${projectsState.projectCreating ? 'disabled' : ''} class="input" name="workspacePath" value="${escapeHtml(
          projectsState.draftProject.workspacePath,
        )}" placeholder="可选；留空将创建独立项目文件夹" />
      </label>

      <label class="label">
        项目目标
        <input ${projectsState.projectCreating ? 'disabled' : ''} class="input" name="summary" value="${escapeHtml(
          projectsState.draftProject.summary,
        )}" placeholder="希望完成什么？" />
      </label>
      <label class="label">
        持续工作要求
        <textarea ${projectsState.projectCreating ? 'disabled' : ''} class="textarea" name="instructions" placeholder="这个项目里，Melo 应遵守哪些要求？">${escapeHtml(
          projectsState.draftProject.instructions,
        )}</textarea>
      </label>
      <div class="inline-actions">


      </div>
    </form>
  `;
}

function renderProjectAgentDefaults(project) {
  const agents = conversationAgents(getBootstrap(), {overview:true,newProjectId:project.id});
  const lead = agents.find(agent => agent.id === (project.defaultAgentId || 'main')) || null;
  const options = agents.map(agent => `<option value="${escapeHtml(agent.id)}" ${project.defaultAgentId === agent.id ? 'selected' : ''}>${escapeHtml(agent.name || agent.id)}</option>`).join('');
  return ui`<section class="surface-card project-detail-panel project-agent-defaults">
    <h2 class="pane-title">Agent 与协作</h2>
    <label class="label">默认 Agent<select class="input" data-project-default-agent="${escapeHtml(project.id)}" ${project.archived ? 'disabled' : ''}><option value="">不指定（沿用当前选择）</option>${options}</select></label>
    <p class="meta-label">在这个项目里开启新对话时使用；团队由这个 Agent 发起。项目内的 Agent 权限只能比全局更严。</p>
    <h3 class="subsection-title">默认团队</h3>
    ${renderTeamPanel({scope:'project',target:project.id,lead,agents,plan:project.teamPlan,disabled:project.archived,escapeHtml,open:true})}
    ${project.teamPlan ? ui`<p class="meta-label">已保存默认团队：${escapeHtml(project.teamPlan.members.map(id => agents.find(agent => agent.id === id)?.name || id).join('、'))}</p><button type="button" class="small-button is-outline" data-action="clear-project-team" data-project-id="${escapeHtml(project.id)}">清除默认团队</button>` : ''}
  </section>`;
}

function renderProjectsDetailView(project) {
  const relatedChats = activeProjectChats();
  const relatedArtifacts = activeProjectArtifacts();

  return ui`
    <section class="page">
      <div class="page-grid project-detail-layout">
        <div class="header-row project-detail-header">
          <div class="project-detail-heading">
            <button
              class="small-button is-outline project-back-button"
              type="button"
              data-action="clear-project-selection"
            >
              <span class="toolbar-icon">${icon.chevronLeft}</span>
              返回项目列表
            </button>
            <h1 class="page-title compact">${escapeHtml(project.name)}</h1>
            ${
              project.summary
                ? ui`<p class="page-kicker">${escapeHtml(project.summary)}</p>`
                : ''
            }
          </div>

          <div class="inline-actions">
            <button
              class="small-button"
              data-action="chat-from-project"
              data-project-id="${project.id}"
              ${project.archived?'disabled':''}
            >
              开启项目对话
            </button>
            <button
              class="small-button is-primary"
              data-action="code-from-project"
              data-project-id="${project.id}"
              ${project.archived?'disabled':''}
            >
              处理项目代码
            </button>
            <button class="small-button is-outline" data-action="archive-project" data-project-id="${project.id}" data-archived="${!project.archived}">${project.archived?t("恢复项目"):t("归档项目")}</button>
            <button class="small-button is-outline" data-action="preview-delete-project" data-project-id="${project.id}">删除项目</button>
            ${projectsState.pendingDeleteProjectId===project.id?ui`<div role="alert">
              <p>对话将解除项目归属，知识、图片与外部文件夹保留；项目记忆隔离保存，待审批失效。</p>
              <button class="small-button" data-action="confirm-delete-project" data-project-id="${project.id}" ${projectsState.lifecycleBusy?'disabled':''}>确认删除项目</button>
              <button class="small-button is-outline" data-action="cancel-delete-project">取消</button>
            </div>`:''}
          </div>
        </div>

        <div class="chip-row">
          <span class="chip is-accent">${escapeHtml(project.tag)}</span>
          ${project.archived?ui`<span class="chip">已归档 · 对话与知识保留</span>`:''}
          <span class="chip">${project.chatCount ?? relatedChats.length} 段对话</span>
          <span class="chip">${project.artifactCount ?? relatedArtifacts.length} 份知识与成果</span>
          ${
            project.workspacePath
              ? ui`<span class="chip mono" title="${escapeHtml(project.workspacePath)}">${escapeHtml(project.workspacePath)}</span>`
              : ui`<span class="chip mono is-muted">未设置工作目录</span>`
          }
        </div>

        <div class="project-detail-grid">
          <section class="surface-card project-detail-panel">
            <h2 class="pane-title">项目设置</h2>
            <form
              class="project-form-card"
              data-form="project-update"
              data-project-id="${project.id}"
            >
              <div class="project-form-grid">
                <label class="label">
                  项目名称
                  <input class="input" name="name" value="${escapeHtml(project.name)}" />
                </label>
                <label class="label">
                  分类
                  <input class="input" name="tag" value="${escapeHtml(project.tag)}" />
                </label>
              </div>
              <label class="label">
                项目文件夹
                <input
                  class="input"
                  name="workspacePath"
                  value="${escapeHtml(project.workspacePath)}"
                  placeholder="可选；留空将创建独立项目文件夹"
                />
              </label>
              ${project.workspaceNeedsConfirmation ? ui`<label class="label"><input type="checkbox" name="confirmWorkspace" />确认允许此项目使用 Melo 程序目录；也可以重新选择文件夹。</label>` : ''}
              <label class="label">
                项目目标
                <input
                  class="input"
                  name="summary"
                  value="${escapeHtml(project.summary)}"
                />
              </label>
              <label class="label">
                持续工作要求
                <textarea class="textarea" name="instructions">${escapeHtml(
                  project.instructions,
                )}</textarea>
              </label>
              <fieldset class="context-materials"><legend>项目共享知识</legend><p>知识按问题与上下文预算选取相关片段，全文保留。</p>
                ${(getBootstrap().artifacts || []).filter(a=>a.content?.trim()).map(a=>ui`<label><input type="checkbox" name="knowledgeIds" value="${escapeHtml(a.id)}" ${(project.knowledgeIds || []).includes(a.id)?'checked':''}>${escapeHtml(a.title)}</label>`).join('') || ui`<p>先在知识库保存知识。</p>`}
              </fieldset>
              <div class="inline-actions">

              </div>
            </form>
          </section>

          <aside class="project-detail-aside">
            ${renderProjectAgentDefaults(project)}
            ${renderMemoryBook(project)}
            <section class="surface-card project-detail-panel">
              <div class="header-row">
                <h2 class="pane-title">相关对话</h2>
                <span class="meta-label">${relatedChats.length} 段</span>
              </div>
              <div class="mini-list">
                ${
                  relatedChats.length
                    ? relatedChats
                        .slice(0, 6)
                        .map(
                          chat => ui`
                            <button
                              class="mini-list-item"
                              data-action="open-chat"
                              data-chat-id="${chat.id}"
                            >
                              <div class="list-row-title">${escapeHtml(chat.title)}</div>
                              <div class="list-row-meta">${escapeHtml(chat.preview)}</div>
                            </button>
                          `,
                        )
                        .join('')
                    : ui`<div class="empty-state compact">还没有相关对话，点击上方开启项目对话。</div>`
                }
              </div>
            </section>

            <section class="surface-card project-detail-panel">
              <div class="header-row">
                <h2 class="pane-title">知识与成果</h2>
                <span class="meta-label">${relatedArtifacts.length} 份</span>
              </div>
              <div class="mini-list">
                ${
                  relatedArtifacts.length
                    ? relatedArtifacts
                        .slice(0, 6)
                        .map(
                          artifact => ui`
                            <button
                              class="mini-list-item"
                              data-action="open-artifact"
                              data-artifact-id="${artifact.id}"
                            >
                              <div class="list-row-title">${escapeHtml(artifact.title)}</div>
                              <div class="list-row-meta">${escapeHtml(
                                truncate(artifact.content, 150),
                              )}</div>
                            </button>
                          `,
                        )
                        .join('')
                    : ui`<div class="empty-state compact">还没有保存的知识或成果。</div>`
                }
              </div>
            </section>
          </aside>
        </div>
      </div>
    </section>
  `;
}

export { renderProjectsPage, renderProjectsOverview, renderProjectCard, renderProjectCreateForm, renderProjectAgentDefaults, renderProjectsDetailView };
