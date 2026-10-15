import { t, ui } from './i18n.js';
export function createSearchPageRenderer({ uiState, escapeHtml, truncate, icon, searchResultIcon, searchBucketsForRender, currentSearchItems }) {
function renderSearchBucket(title, itemsHtml, count) {
  return ui`
    <section class="surface-card search-bucket">
      <div class="search-bucket-header">
        <h2 class="pane-title">${title}</h2>
        <span class="chip">${count}</span>
      </div>
      <div class="search-list">${itemsHtml}</div>
    </section>
  `;
}

function renderSearchResultButton(item) {
  // Workspace file-group rows carry a `hits: [...]` array of per-line hits
  // from `streamWorkspaceContentByFile`.  When we have at least one extra
  // hit beyond the top-scoring line that the group already advertises, we
  // render an expandable sub-list so the user can drill into a specific
  // line without having to open the file first.
  const hasSubHits =
    Array.isArray(item.hits) && item.hits.length > 0 && item.filePath;

  if (!hasSubHits) {
    return ui`
    <button
      class="search-action-button"
      data-action="open-search-result"
      data-result-id="${escapeHtml(item.id)}"
    >
      <span class="search-action-icon">${searchResultIcon(item)}</span>
      <span class="search-action-copy">
        <span class="search-action-title-row">
          <span class="search-action-title">${escapeHtml(item.title)}</span>
          ${
            item.badge
              ? ui`<span class="search-action-badge">${escapeHtml(item.badge)}</span>`
              : ''
          }
        </span>
        ${
          item.subtitle
            ? ui`<span class="search-action-subtitle">${escapeHtml(item.subtitle)}</span>`
            : ''
        }
      </span>
      ${
        item.meta
          ? ui`<span class="search-action-meta">${escapeHtml(item.meta)}</span>`
          : ''
      }
    </button>
  `;
  }

  const isExpanded = Boolean(uiState.expandedSearchGroups?.[item.filePath]);
  const subHitCount = item.hits.length;
  const expandLabel = isExpanded
    ? `Hide ${subHitCount} match${subHitCount === 1 ? '' : 'es'}`
    : `Show ${subHitCount} match${subHitCount === 1 ? '' : 'es'}`;

  return ui`
    <div class="search-action-row search-action-row--file-group${
      isExpanded ? ' is-expanded' : ''
    }">
      <div class="search-action-row-head">
        <button
          class="search-action-button search-action-button--grow"
          data-action="open-search-result"
          data-result-id="${escapeHtml(item.id)}"
        >
          <span class="search-action-icon">${searchResultIcon(item)}</span>
          <span class="search-action-copy">
            <span class="search-action-title-row">
              <span class="search-action-title">${escapeHtml(item.title)}</span>
              ${
                item.badge
                  ? ui`<span class="search-action-badge">${escapeHtml(item.badge)}</span>`
                  : ''
              }
            </span>
            ${
              item.subtitle
                ? ui`<span class="search-action-subtitle">${escapeHtml(item.subtitle)}</span>`
                : ''
            }
          </span>
          ${
            item.meta
              ? ui`<span class="search-action-meta">${escapeHtml(item.meta)}</span>`
              : ''
          }
        </button>
        <button
          type="button"
          class="search-action-expand"
          data-action="toggle-search-group-hits"
          data-file-path="${escapeHtml(item.filePath)}"
          aria-expanded="${isExpanded ? 'true' : 'false'}"
          title="${escapeHtml(expandLabel)}"
        >
          <span class="search-action-expand-chip">${subHitCount}</span>
          <span class="search-action-expand-caret">${isExpanded ? '▾' : '▸'}</span>
        </button>
      </div>
      ${
        isExpanded
          ? ui`<div class="search-action-sublist" role="list">${item.hits
              .map(hit => renderSearchResultSubHit(item, hit))
              .join('')}</div>`
          : ''
      }
    </div>
  `;
}

// Render a single per-line hit underneath an expanded file-group row.
// Clicking a sub-hit directly opens the file at that specific line (it
// ignores the group's own top-scoring line in favour of the line the user
// actually clicked).  We avoid injecting these into `currentSearchItems`
// because they are drill-downs, not independently rankable results — the
// click boost is credited to the parent group.
function renderSearchResultSubHit(parent, hit) {
  const rawLine = Number(hit?.lineNumber) || 0;
  const previewText = hit?.lineText || hit?.subtitle || '';
  const preview = truncate(String(previewText).trim(), 160);
  return ui`
    <button
      type="button"
      class="search-action-subhit"
      role="listitem"
      data-action="open-file-match-line"
      data-file-path="${escapeHtml(parent.filePath)}"
      data-line-number="${rawLine}"
      data-parent-result-id="${escapeHtml(parent.id)}"
    >
      <span class="search-action-subhit-line">L${rawLine || '?'}</span>
      <span class="search-action-subhit-text">${escapeHtml(preview)}</span>
    </button>
  `;
}

function renderSearchPage() {
  const query = uiState.searchQuery.trim();
  const buckets = searchBucketsForRender();
  const activeResults = currentSearchItems();
  const total = activeResults.length;
  const functionCount = activeResults.filter(item =>
    ['feature', 'skill', 'connector'].includes(item.kind),
  ).length;
  const chatCount = activeResults.filter(
    item => item.kind === 'chat-thread' || item.kind === 'chat-hit',
  ).length;

  return ui`
    <section class="page search-page">
      <div class="search-stage">
        <div class="search-panel">
          <div class="search-panel-header">
            <span class="search-panel-icon">${icon.search}</span>
            <input
              class="search-input search-panel-input"
              id="global-search"
              type="search"
              value="${escapeHtml(uiState.searchQuery)}"
              placeholder="Search chats, memory, features, projects, artifacts, and files"
            />
            <button
              class="search-clear-button"
              type="button"
              data-action="clear-search-query"
              title="Clear search"
            >
              ×
            </button>
          </div>

          <div class="search-panel-body">
            <div class="search-panel-meta">
              ${
                query
                  ? ui`
                    <span class="chip">${total} result${total === 1 ? '' : 's'}</span>
                    <span class="chip">${functionCount} functions</span>
                    <span class="chip">${chatCount} chat matches</span>
                  `
                  : '<span class="meta-label">Search everything in Melo with fuzzy matching.</span>'
              }
              ${
                uiState.searchLoading
                  ? '<span class="meta-label">Refreshing…</span>'
                  : ''
              }
              ${
                uiState.searchFileLoading
                  ? '<span class="meta-label">Searching files…</span>'
                  : ''
              }
            </div>

            ${
              total
                ? ui`
                  <div class="search-buckets">
                    ${buckets
                      .map(bucket =>
                        renderSearchBucket(
                          bucket.title,
                          bucket.items.map(renderSearchResultButton).join(''),
                          bucket.items.length,
                        ),
                      )
                      .join('')}
                  </div>
                `
                : query
                  ? ui`<div class="empty-state">
                      <div class="empty-state-title">No matches for "${escapeHtml(query)}".</div>
                      <div class="empty-state-meta">
                        Search covers <strong>chats &amp; messages</strong>,
                        <strong>prompt history</strong>,
                        <strong>memory</strong>,
                        <strong>artifacts</strong>,
                        <strong>projects</strong>,
                        <strong>skills / connectors</strong>, and
                        <strong>workspace files</strong>. Try simpler keywords, an exact phrase, or check spelling.
                      </div>
                    </div>`
                  : ui`<div class="empty-state">
                      <div class="empty-state-title">Start typing to search.</div>
                      <div class="empty-state-meta">
                        Looks across chats, messages, memory, artifacts, projects, and workspace files.
                        A file path, a project name, or a phrase you remember from a past chat all work.
                      </div>
                    </div>`
            }
          </div>
        </div>
      </div>
    </section>
  `;
}

return { renderSearchPage };
}
