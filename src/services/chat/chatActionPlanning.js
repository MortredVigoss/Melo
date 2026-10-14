// Chat-graph action planning + approval-response composition —
// sub-phase 7d-5δ commit 1 of the desktopStore decomposition.
// byte-for-byte port (CLAUDE.md §5).
//
// This module is the self-contained "plan an approval-required action
// from the latest user turn" cluster used by the chat execution graph.
// Two planners (local-command and external-mcp connector tool) feed a
// thin entry that returns the first non-null match; a separate helper
// composes the model-facing approval response when the graph commits to
// the plan.
//
// Members (all originally LOCAL to desktopStore, none with external
// callers — they ship together as a cluster):
//
//   • normalizeGraphNeedle           pure string → lowercase punctuation-stripped form
//   • extractSearchQueryFromMessage  best-effort search-text extraction
//   • planCommandAction              picks a curated COMMAND_TEMPLATES entry from natural-language
//   • extractConnectorToolInput      best-effort parse of inline JSON / tail-args
//   • planExternalConnectorAction    matches against enabled external-MCP connector tools
//   • planChatGraphAction            entry: returns the first non-null planner result
//   • buildApprovalResponse          assistant-facing message body when the graph commits to a plan
//
// Only `agentUsesTool` is imported from outside the cluster.

import { agentUsesTool } from '../../domain/agent/agentTools.js';
import { isExplicitActionRequest, isExplicitLocalSearch, maskQuotedText } from '../../retrieval/requestPolicy.js';

function normalizeGraphNeedle(value = '') {
  return String(value || '')
    .toLowerCase()
    .replace(/[`"'“”‘’()（）{}\[\]<>《》,，.。!?！？:：;；/\\|_~-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractSearchQueryFromMessage(message = '') {
  const raw = String(message || '').trim();
  if (!raw) {
    return '';
  }

  const action = maskQuotedText(raw).match(/\b(?:search|find|grep|ripgrep|rg)\b|搜索|查找|检索/iu);
  if (!action) return '';
  const tail = raw.slice(action.index + action[0].length).trim();
  const quotedMatch = tail.match(/["“”'‘’](.+?)["“”'‘’]/);
  if (quotedMatch?.[1]) {
    return /[\p{L}\p{N}]/u.test(quotedMatch[1]) ? quotedMatch[1].trim() : '';
  }

  const patterns = [
    /(?:search|find|grep|ripgrep|rg)\s+(?:for\s+)?(.+)$/i,
    /(?:搜索|查找|检索)\s*(.+)$/i,
  ];

  for (const pattern of patterns) {
    const match = raw.match(pattern);
    if (match?.[1]) {
      const query = match[1].trim().replace(/^(?:the |this )?(?:workspace|repo(?:sitory)?|codebase|local files)\s+(?:for\s+)?/iu, '').replace(/[。.!！?？]+$/u, '').trim();
      return /[\p{L}\p{N}]/u.test(query) ? query : '';
    }
  }

  return '';
}

function planCommandAction({ latestUserMessage = '', activeAgentProfile, chat }) {
  if (!agentUsesTool(activeAgentProfile, 'local-command')) {
    return null;
  }

  const raw = String(latestUserMessage || '').trim();
  const message = normalizeGraphNeedle(raw);
  if (!message || !isExplicitActionRequest(raw)) {
    return null;
  }

  const commandSpecs = [
    {
      templateId: 'git-status',
      title: 'Run Git status',
      patterns: [/git status/i, /仓库状态/i, /git 状态/i, /当前分支/i],
    },
    {
      templateId: 'npm-build',
      title: 'Run project build',
      patterns: [/npm run build/i, /\brun build\b/i, /\bbuild the project\b/i, /构建/i],
    },
    {
      templateId: 'pwd',
      title: 'Show working directory',
      patterns: [/\bpwd\b/i, /working directory/i, /workspace root/i, /工作目录/i, /根目录/i],
    },
    {
      templateId: 'list-files',
      title: 'List workspace files',
      patterns: [/\bls\b/i, /list files/i, /show files/i, /列出文件/i, /文件列表/i],
    },
  ];

  const quotedCommand = /^(?:(?:please|can you|could you)\s+)*(?:run|execute)\s+[`"“]|^(?:请|帮我|请帮我)?(?:运行|执行)\s*[`"“]/iu.test(raw);
  const commandText = quotedCommand ? raw : maskQuotedText(raw);
  for (const spec of commandSpecs) {
    if (spec.patterns.some(pattern => {
      const match = pattern.exec(commandText);
      if (!match) return false;
      const prefix = commandText.slice(0, match.index).replace(/[`"“]/gu, '').trim();
      return /^(?:(?:please|can you|could you|would you|run|execute|show|use|list)\s*)*$/iu.test(prefix) ||
        /^(?:(?:请|麻烦|帮我|运行|执行|查看|显示|使用|列出)\s*)*$/u.test(prefix);
    })) {
      return {
        kind: 'command',
        requiresApproval: true,
        title: spec.title,
        description: `Queue approval to run ${spec.title.toLowerCase()} for this chat.`,
        payload: {
          templateId: spec.templateId,
          query: '',
          projectId: chat?.projectId || null,
        },
      };
    }
  }

  if (
    isExplicitLocalSearch(raw)
  ) {
    const query = extractSearchQueryFromMessage(raw);
    if (query) {
      return {
        kind: 'command',
        requiresApproval: true,
        title: 'Search workspace text',
        description: `Queue approval to search the workspace for "${query}".`,
        payload: {
          templateId: 'search-text',
          query,
          projectId: chat?.projectId || null,
        },
      };
    }
  }

  return null;
}

function extractConnectorToolInput(message = '', matchedToolName = '') {
  const raw = String(message || '').trim();
  const toolIndex = matchedToolName ? raw.toLowerCase().indexOf(matchedToolName.toLowerCase()) : -1;
  const remainder = toolIndex >= 0 ? raw.slice(toolIndex + matchedToolName.length).trim() : '';
  const jsonMatch = raw.match(/\{[\s\S]+\}$/);
  if (jsonMatch?.[0]) {
    try {
      return JSON.parse(jsonMatch[0]);
    } catch {}
  }

  return {
    query: remainder || raw,
  };
}

function planExternalConnectorAction({
  latestUserMessage = '',
  activeAgentProfile,
  agentConnectors = [],
  chat,
}) {
  if (!agentUsesTool(activeAgentProfile, 'external-connectors')) {
    return null;
  }

  const raw = String(latestUserMessage || '').trim();
  const message = normalizeGraphNeedle(maskQuotedText(raw));
  if (!message || !isExplicitActionRequest(raw)) {
    return null;
  }

  for (const connector of agentConnectors.filter(
    entry => entry.type === 'external-mcp' && entry.enabled,
  )) {
    const connectorNeedle = normalizeGraphNeedle(connector.name);
    for (const tool of connector.manifest?.tools || []) {
      const toolNeedle = normalizeGraphNeedle(tool.name);
      const matched =
        (toolNeedle && message.includes(toolNeedle)) ||
        (connectorNeedle &&
          toolNeedle &&
          message.includes(connectorNeedle) &&
          message.includes(toolNeedle));

      if (!matched) {
        continue;
      }

      return {
        kind: 'external-tool',
        requiresApproval: true,
        title: `Run ${connector.name} / ${tool.name}`,
        description: `Queue approval to run ${tool.name} on ${connector.name}.`,
        payload: {
          connectorId: connector.id,
          toolName: tool.name,
          input: extractConnectorToolInput(raw, tool.name),
          projectId: chat?.projectId || null,
        },
      };
    }
  }

  return null;
}

export function planChatGraphAction({
  latestUserMessage = '',
  activeAgentProfile,
  agentConnectors = [],
  chat,
}) {
  return (
    planExternalConnectorAction({
      latestUserMessage,
      activeAgentProfile,
      agentConnectors,
      chat,
    }) ||
    planCommandAction({
      latestUserMessage,
      activeAgentProfile,
      chat,
    }) ||
    null
  );
}

export function buildApprovalResponse(plannedAction, approval) {
  const label =
    plannedAction.kind === 'external-tool' ? 'connector tool' : 'local action';
  return [
    `I prepared a ${label} request for this thread.`,
    `Title: ${approval.title}`,
    approval.description ? approval.description : '',
    'Open the approval queue and approve it when you want Melo to execute it.',
  ]
    .filter(Boolean)
    .join('\n\n');
}
