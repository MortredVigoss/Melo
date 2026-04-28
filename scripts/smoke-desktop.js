import { readFile } from 'node:fs/promises';
import { buildConversationContinuityContext } from '../src/desktopStore.js';

const baseUrl = process.env.MELO_SMOKE_BASE_URL || 'http://127.0.0.1:43129';
const telegramMockUrl = process.env.MELO_TELEGRAM_MOCK_BASE_URL || '';
const telegramMockToken = process.env.MELO_MOCK_TELEGRAM_TOKEN || 'melo-mock-telegram-token';

async function request(path, options = {}) {
  return requestTo(baseUrl, path, options);
}

async function requestTo(origin, path, options = {}) {
  const response = await fetch(`${origin}${path}`, {
    headers: {
      'content-type': 'application/json',
      ...(options.headers || {}),
    },
    method: options.method || 'GET',
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`${path}: ${payload.error || response.statusText}`);
  }

  return payload;
}

async function requestTelegramMock(path, options = {}) {
  return requestTo(telegramMockUrl, path, options);
}

function parseEventBlock(block) {
  const lines = block
    .split(/\r?\n/)
    .map(line => line.trimEnd());
  let event = 'message';
  const dataLines = [];

  for (const line of lines) {
    if (!line || line.startsWith(':')) continue;
    if (line.startsWith('event:')) {
      event = line.slice(6).trimStart() || event;
      continue;
    }
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart());
    }
  }

  if (!dataLines.length) {
    return null;
  }

  return {
    event,
    payload: JSON.parse(dataLines.join('\n').trim()),
  };
}

async function requestStream(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: {
      'content-type': 'application/json',
      ...(options.headers || {}),
    },
    method: options.method || 'GET',
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(`${path}: ${payload.error || response.statusText}`);
  }

  if (!response.body) {
    throw new Error(`${path}: stream body missing`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let deltaCount = 0;
  let latestText = '';
  let donePayload = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });

    while (true) {
      const separatorIndex = buffer.search(/\r?\n\r?\n/);
      if (separatorIndex === -1) {
        break;
      }

      const block = buffer.slice(0, separatorIndex);
      const separatorLength = buffer.startsWith('\r\n\r\n', separatorIndex) ? 4 : 2;
      buffer = buffer.slice(separatorIndex + separatorLength);
      const message = parseEventBlock(block);
      if (!message) {
        continue;
      }

      if (message.event === 'delta') {
        deltaCount += 1;
        latestText = message.payload?.text || latestText;
      } else if (message.event === 'done') {
        donePayload = message.payload;
      } else if (message.event === 'error') {
        throw new Error(`${path}: ${message.payload?.error || 'stream error'}`);
      }
    }
  }

  return {
    deltaCount,
    latestText,
    done: donePayload,
  };
}

async function requestEventStream(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: {
      'content-type': 'application/json',
      ...(options.headers || {}),
    },
    method: options.method || 'GET',
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(`${path}: ${payload.error || response.statusText}`);
  }

  if (!response.body) {
    throw new Error(`${path}: stream body missing`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const hits = [];
  let donePayload = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    while (true) {
      const separatorIndex = buffer.search(/\r?\n\r?\n/);
      if (separatorIndex === -1) {
        break;
      }

      const block = buffer.slice(0, separatorIndex);
      const separatorLength = buffer.startsWith('\r\n\r\n', separatorIndex) ? 4 : 2;
      buffer = buffer.slice(separatorIndex + separatorLength);
      const message = parseEventBlock(block);
      if (!message) {
        continue;
      }

      if (message.event === 'group') {
        // P3 follow-up #3: the server now emits only 'group' events (one
        // per file, carrying `filePath` + `subtitle` + a `hits` array with
        // up to 3 representative lines).  The transitional per-line 'hit'
        // event was retired — downstream assertions keep working because
        // each group already exposes `filePath` + `subtitle` at the top
        // level, matching the old per-line shape.
        hits.push(message.payload);
      } else if (message.event === 'done') {
        donePayload = message.payload;
      } else if (message.event === 'error') {
        throw new Error(`${path}: ${message.payload?.error || 'stream error'}`);
      }
    }
  }

  return {
    hits,
    done: donePayload,
  };
}

async function main() {
  await request('/api/bootstrap');
  const homeBootstrap = await request('/api/settings', {
    method: 'POST',
    body: {
      activeView: 'chat',
      activeMode: 'chat',
      selectedChatId: null,
      selectedFilePath: null,
    },
  });

  if (homeBootstrap.settings.selectedChatId !== null) {
    throw new Error('New chat home did not preserve a null selectedChatId.');
  }

  const searchViewBootstrap = await request('/api/settings', {
    method: 'POST',
    body: {
      activeView: 'search',
    },
  });

  const agentViewBootstrap = await request('/api/settings', {
    method: 'POST',
    body: {
      activeView: 'agent',
    },
  });

  const modelViewBootstrap = await request('/api/settings', {
    method: 'POST',
    body: {
      activeView: 'model',
    },
  });

  const modelOptionsBootstrap = await request('/api/settings/model/options', {
    method: 'POST',
    body: {
      authMode: 'codex',
      baseUrl: 'https://chatgpt.com/backend-api',
      model: 'gpt-5.5',
    },
  });

  await request('/api/settings', {
    method: 'POST',
    body: {
      activeView: 'chat',
      activeMode: 'chat',
      selectedChatId: null,
      selectedFilePath: null,
    },
  });

  const initial = homeBootstrap;
  const projectId = initial.settings.selectedProjectId;
  const homePrompt = 'How large is Singapore?';
  const smokeFilePath = 'melo-smoke-output.md';
  const connectorBaseUrl = process.env.MELO_CONNECTOR_BASE_URL || '';
  const runId = `${Date.now()}`;
  const approvalTitle = `Smoke approval ${runId}`;
  const taskTitle = `Smoke task ${runId}`;
  const laneTaskTitle = `Smoke lane task ${runId}`;
  const smokeArtifactBody = `Artifact body ${runId}`;
  const transparentImageDataUrl =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WnRk0QAAAAASUVORK5CYII=';
  const mainAgent = (initial.customize?.agents || []).find(agent => agent.id === 'main') || null;
  const alternateMainMood = mainAgent?.mood === 'warm' ? 'calm' : 'warm';
  const originalToolIds = Array.isArray(mainAgent?.toolIds)
    ? [...mainAgent.toolIds]
    : Array.isArray(mainAgent?.tools)
      ? mainAgent.tools.map(tool => tool.id)
      : [];
  const alternateToolIds = originalToolIds.includes('search')
    ? originalToolIds.filter(toolId => toolId !== 'search')
    : [...originalToolIds, 'search'];
  const alternateModel = 'melo-smoke-model';
  const alternateSystemPrompt = `Smoke system prompt ${runId}`;
  const preset = (initial.customize?.agentPresets || [])[0] || null;
  let updatedAgentPayload = null;
  let importedPresetPayload = null;
  let projectOverridePayload = null;

  const homeChatBootstrap = await request('/api/chats', {
    method: 'POST',
    body: {
      mode: 'chat',
      projectId,
    },
  });

  const homeChatId = homeChatBootstrap.settings.selectedChatId;

  const homeSentStream = await requestStream('/api/chat/send/stream', {
    method: 'POST',
    body: {
      chatId: homeChatId,
      content: homePrompt,
      mode: 'chat',
    },
  });
  const homeSent = homeSentStream.done;
  const homeFollowUpPrompt = 'Continue this thread with a second turn.';
  const homeFollowUpStream = await requestStream('/api/chat/send/stream', {
    method: 'POST',
    body: {
      chatId: homeSent.bootstrap?.settings?.selectedChatId || homeChatId,
      content: homeFollowUpPrompt,
      mode: 'chat',
    },
  });
  const homeFollowUp = homeFollowUpStream.done;
  const homeThirdTurnPrompt = 'And answer one more follow-up in the same thread.';
  const homeThirdTurnStream = await requestStream('/api/chat/send/stream', {
    method: 'POST',
    body: {
      chatId: homeFollowUp.bootstrap?.settings?.selectedChatId || homeChatId,
      content: homeThirdTurnPrompt,
      mode: 'chat',
    },
  });
  const homeThirdTurn = homeThirdTurnStream.done;
  const continuityProbe = buildConversationContinuityContext(
    {
      messages: [
        {
          role: 'user',
          content: 'lancelot',
          attachments: [],
        },
        {
          role: 'assistant',
          content:
            '你是指 Lancelot 吗？可能是这些之一：\n- 亚瑟王传说中的兰斯洛特\n- (Fate) 里的 Lancelot\n- 某个游戏/角色/项目名\n\n你告诉我你想了解哪一个，我可以直接继续。',
          attachments: [],
        },
        {
          role: 'user',
          content: '亚瑟王',
          attachments: [],
        },
      ],
    },
    '亚瑟王',
  );

  if (mainAgent) {
    if (preset) {
      importedPresetPayload = await request('/api/agents/update', {
        method: 'POST',
        body: {
        agentId: 'main',
        scope: 'global',
        patch: {
          identity: preset.identity || preset.identify,
          'soul.md': preset.soulMd,
          mood: preset.mood,
          tools: originalToolIds,
          model: mainAgent.model || '',
          systemPrompt: mainAgent.systemPrompt || '',
        },
        },
      });
    }

    updatedAgentPayload = await request('/api/agents/update', {
      method: 'POST',
      body: {
        agentId: 'main',
        scope: 'global',
        patch: {
          identity: mainAgent.identity || mainAgent.identify,
          'soul.md': mainAgent.soulMd,
          mood: alternateMainMood,
          tools: alternateToolIds,
          model: alternateModel,
          systemPrompt: alternateSystemPrompt,
        },
      },
    });

    await request('/api/agents/update', {
      method: 'POST',
      body: {
        agentId: 'main',
        scope: 'global',
        patch: {
          identity: mainAgent.identity || mainAgent.identify,
          'soul.md': mainAgent.soulMd,
          mood: mainAgent.mood,
          tools: originalToolIds,
          model: mainAgent.model || '',
          systemPrompt: mainAgent.systemPrompt || '',
        },
      },
    });

    projectOverridePayload = await request('/api/agents/update', {
      method: 'POST',
      body: {
        agentId: 'main',
        scope: 'project',
        projectId,
        patch: {
          identity: `Project override main agent ${runId}`,
          'soul.md': `# Project override\nThis agent is scoped to ${projectId} for smoke verification ${runId}.`,
          mood: 'intense',
        },
      },
    });

    await request('/api/agents/update', {
      method: 'POST',
      body: {
        agentId: 'main',
        scope: 'project',
        projectId,
        clearProjectOverride: true,
      },
    });
  }

  let externalConnector = null;
  if (connectorBaseUrl) {
    const existingConnector = (initial.customize?.connectors || []).find(
      connector => connector.type === 'external-mcp' && connector.name === 'Smoke MCP',
    );

    if (existingConnector) {
      await request('/api/connectors/external/update', {
        method: 'POST',
        body: {
          connectorId: existingConnector.id,
          patch: {
            name: 'Smoke MCP',
            description: 'Mock MCP-style connector used for Melo smoke testing.',
            endpoint: connectorBaseUrl,
            prompt: 'Use this connector for smoke-test retrieval context.',
            healthPath: '/health',
            manifestPath: '/manifest',
            contextPath: '/context',
            invokePath: '/invoke',
          },
        },
      });

      if (!existingConnector.enabled) {
        await request('/api/customize/connector-toggle', {
          method: 'POST',
          body: {
            connectorId: existingConnector.id,
          },
        });
      }

      externalConnector = existingConnector;
    } else {
      const createdConnector = await request('/api/connectors/external', {
        method: 'POST',
        body: {
          name: 'Smoke MCP',
          description: 'Mock MCP-style connector used for Melo smoke testing.',
          endpoint: connectorBaseUrl,
          prompt: 'Use this connector for smoke-test retrieval context.',
          healthPath: '/health',
          manifestPath: '/manifest',
          contextPath: '/context',
          invokePath: '/invoke',
        },
      });

      externalConnector = (createdConnector.customize?.connectors || []).find(
        connector => connector.type === 'external-mcp' && connector.name === 'Smoke MCP',
      );
    }

    if (externalConnector?.id) {
      const pinged = await request('/api/connectors/external/ping', {
        method: 'POST',
        body: {
          connectorId: externalConnector.id,
        },
      });
      externalConnector = (pinged.customize?.connectors || []).find(
        connector => connector.id === externalConnector.id,
      );

      const invoked = await request('/api/connectors/external/invoke', {
        method: 'POST',
        body: {
          connectorId: externalConnector.id,
          toolName: 'docs.search',
          input: JSON.stringify({ query: 'smoke connector' }),
          projectId,
        },
      });

      externalConnector = (invoked.bootstrap?.customize?.connectors || []).find(
        connector => connector.id === externalConnector.id,
      );

      await request('/api/connectors/external/resource', {
        method: 'POST',
        body: {
          connectorId: externalConnector.id,
          resourceId: 'docs://smoke/readme',
          projectId,
        },
      });

      await request('/api/connectors/external/prompt', {
        method: 'POST',
        body: {
          connectorId: externalConnector.id,
          promptId: 'triage',
          projectId,
        },
      });
    }
  }

  if (mainAgent) {
    const graphToolIds = [...new Set([...originalToolIds, 'external-connectors'])];
    await request('/api/agents/update', {
      method: 'POST',
      body: {
        agentId: 'main',
        scope: 'global',
        patch: {
          identity: mainAgent.identity || mainAgent.identify,
          'soul.md': mainAgent.soulMd,
          mood: mainAgent.mood,
          tools: graphToolIds,
          model: mainAgent.model || '',
          systemPrompt: mainAgent.systemPrompt || '',
        },
      },
    });
  }

  const created = await request('/api/chats', {
    method: 'POST',
    body: {
      mode: 'code',
      projectId,
    },
  });
  const chatId = created.settings.selectedChatId;

  const saved = await request('/api/workspace/save-file', {
    method: 'POST',
    body: {
      filePath: smokeFilePath,
      content: '# Smoke file\nSaved from the Melo desktop smoke test.\n',
      projectId,
    },
  });

  const selected = await request('/api/workspace/select-file', {
    method: 'POST',
    body: {
      filePath: smokeFilePath,
    },
  });

  const command = await request('/api/command/run', {
    method: 'POST',
    body: {
      templateId: 'search-text',
      query: 'Smoke file',
      projectId,
    },
  });

  const artifact = await request('/api/artifacts', {
    method: 'POST',
    body: {
      title: 'Smoke artifact',
      content: `# Smoke\n${smokeArtifactBody}`,
      language: 'markdown',
      kind: 'note',
      projectId,
    },
  });

  const applied = await request('/api/artifacts/apply', {
    method: 'POST',
    body: {
      artifactId: artifact.artifacts?.[0]?.id,
      filePath: smokeFilePath,
      projectId,
    },
  });

  const sentStream = await requestStream('/api/chat/send/stream', {
    method: 'POST',
    body: {
      chatId,
      content: 'Summarize the selected file in code mode',
      mode: 'code',
    },
  });
  const sent = sentStream.done;

  const richSentStream = await requestStream('/api/chat/send/stream', {
    method: 'POST',
    body: {
      chatId,
      content: 'Keep this resource for later',
      mode: 'chat',
      attachments: [
        {
          kind: 'image',
          url: transparentImageDataUrl,
          title: 'Smoke image',
        },
        {
          kind: 'link',
          url: 'https://example.com/melo-smoke',
          title: 'Smoke link',
        },
      ],
    },
  });
  const richSent = richSentStream.done;
  const graphCommandStream = await requestStream('/api/chat/send/stream', {
    method: 'POST',
    body: {
      chatId,
      content: 'Please run git status for this workspace.',
      mode: 'chat',
    },
  });
  const graphCommandPayload = graphCommandStream.done;
  const graphCommandApproval =
    (graphCommandPayload?.bootstrap?.approvals || []).find(
      item =>
        item.kind === 'command' &&
        item.status === 'pending' &&
        item.chatId === chatId &&
        item.title === 'Run Git status',
    ) || null;
  let graphExternalApproval = null;
  if (externalConnector) {
    const graphExternalStream = await requestStream('/api/chat/send/stream', {
      method: 'POST',
      body: {
        chatId,
        content: 'Use docs.search on Smoke MCP to look up smoke connector guidance.',
        mode: 'chat',
      },
    });
    const graphExternalPayload = graphExternalStream.done;
    graphExternalApproval =
      (graphExternalPayload?.bootstrap?.approvals || []).find(
        item =>
          item.kind === 'external-tool' &&
          item.status === 'pending' &&
          item.chatId === chatId &&
          item.title === 'Run Smoke MCP / docs.search',
      ) || null;
  }

  const searched = await request('/api/bootstrap?q=melo-smoke');
  const featureSearch = await request('/api/bootstrap?q=agent mood');
  const chatSearch = await request('/api/bootstrap?q=selected file');
  const agentFeatureSearch = await request('/api/bootstrap?q=identity soul');
  const modelFeatureSearch = await request('/api/bootstrap?q=model oauth');
  const fileContentSearch = await requestEventStream(
    '/api/search/files?q=' + encodeURIComponent(smokeArtifactBody) +
      `&projectId=${encodeURIComponent(projectId)}`,
  );
  let telegramRoundTripTitle = null;
  let telegramRoundTripReply = null;
  let telegramRoundTripAgentId = null;
  let telegramRoundTripCount = 0;
  let telegramTypingCount = 0;
  let telegramImageRoundTripReply = null;
  let telegramImageRoundTripCount = 0;

  if (telegramMockUrl) {
    await requestTelegramMock('/__reset', {
      method: 'POST',
    });

    const createdTelegramAgent = await request('/api/agents/create-custom', {
      method: 'POST',
    });
    telegramRoundTripAgentId = createdTelegramAgent.settings?.selectedAgentId || null;

    if (telegramRoundTripAgentId) {
      await request('/api/agents/update', {
        method: 'POST',
        body: {
          agentId: telegramRoundTripAgentId,
          scope: 'global',
          patch: {
            name: 'Telegram smoke agent',
            description: 'Used to verify Telegram round-trips in the smoke suite.',
            channels: {
              telegram: {
                enabled: true,
                botToken: telegramMockToken,
                chatId: 'telegram-smoke',
              },
              discord: {
                enabled: false,
                botToken: '',
                guildId: '',
                channelId: '',
              },
            },
          },
        },
      });

      telegramRoundTripTitle = 'Telegram smoke ping';
      await requestTelegramMock('/__seed-update', {
        method: 'POST',
        body: {
          chatId: 'telegram-smoke',
          text: telegramRoundTripTitle,
        },
      });

      const deadline = Date.now() + 12000;
      while (Date.now() < deadline) {
        const sentPayload = await requestTelegramMock('/__sent');
        telegramRoundTripCount = Array.isArray(sentPayload.sentMessages)
          ? sentPayload.sentMessages.length
          : 0;
        telegramTypingCount = Array.isArray(sentPayload.sentActions)
          ? sentPayload.sentActions.filter(action => action.action === 'typing').length
          : 0;
        if (telegramRoundTripCount > 0) {
          telegramRoundTripReply = sentPayload.sentMessages[telegramRoundTripCount - 1]?.text || null;
          break;
        }

        await new Promise(resolve => setTimeout(resolve, 350));
      }

      if (!telegramRoundTripReply) {
        throw new Error('Telegram mock did not receive a reply from Melo.');
      }

      if (telegramTypingCount < 1) {
        throw new Error('Telegram mock did not observe a typing indicator.');
      }

      await requestTelegramMock('/__seed-update', {
        method: 'POST',
        body: {
          chatId: 'telegram-smoke',
          photo: true,
        },
      });

      const imageDeadline = Date.now() + 12000;
      while (Date.now() < imageDeadline) {
        const sentPayload = await requestTelegramMock('/__sent');
        const sentMessages = Array.isArray(sentPayload.sentMessages)
          ? sentPayload.sentMessages
          : [];
        if (sentMessages.length > telegramRoundTripCount) {
          telegramImageRoundTripCount = sentMessages.length;
          telegramImageRoundTripReply = sentMessages[sentMessages.length - 1]?.text || null;
          break;
        }

        await new Promise(resolve => setTimeout(resolve, 350));
      }

      if (!telegramImageRoundTripReply) {
        throw new Error('Telegram mock did not receive a reply to a photo-only update from Melo.');
      }
    }
  }

  const approval = await request('/api/approvals', {
    method: 'POST',
    body: {
      kind: 'command',
      title: approvalTitle,
      description: 'Run the smoke command via approval flow.',
      projectId,
      payload: {
        templateId: 'git-status',
        query: '',
        projectId,
      },
    },
  });

  const pendingApproval = (approval.approvals || []).find(item => item.title === approvalTitle);
  const approvalExecuted = pendingApproval?.id
    ? await request('/api/approvals/execute', {
        method: 'POST',
        body: {
          approvalId: pendingApproval.id,
        },
      })
    : null;

  const createdTask = await request('/api/tasks', {
    method: 'POST',
    body: {
      title: taskTitle,
      summary: 'Verify single worker task flow.',
      owner: 'builder',
      kind: 'agent',
      projectId,
      chatId,
    },
  });

  const laneTask = await request('/api/tasks', {
    method: 'POST',
    body: {
      title: laneTaskTitle,
      summary: 'Verify worker lane execution.',
      owner: 'reviewer',
      kind: 'agent',
      projectId,
      chatId,
    },
  });

  const task = (createdTask.tasks || []).find(item => item.title === taskTitle);
  const ranTask = task?.id
    ? await request('/api/tasks/run', {
        method: 'POST',
        body: {
          taskId: task.id,
        },
      })
    : null;

  const ranLane = await request('/api/tasks/run-lane', {
    method: 'POST',
    body: {
      owner: 'reviewer',
    },
  });

  const mainUpdatedAgent =
    updatedAgentPayload?.customize?.agents?.find(agent => agent.id === 'main') || null;
  const identityFileContent = mainUpdatedAgent?.identityPath
    ? await readFile(mainUpdatedAgent.identityPath, 'utf8')
    : '';
  const soulFileContent = mainUpdatedAgent?.soulPath
    ? await readFile(mainUpdatedAgent.soulPath, 'utf8')
    : '';

  const summary = {
    homeSelectedChatId: homeBootstrap.settings.selectedChatId,
    homeThreadSelectedChatId: homeSent.bootstrap?.settings?.selectedChatId || null,
    homeThreadTitle: homeSent.bootstrap?.activeChat?.title || null,
    homeRecentTitle: homeSent.bootstrap?.recents?.[0]?.title || null,
    homeStreamDeltaCount: homeSentStream.deltaCount,
    homeFollowUpStreamDeltaCount: homeFollowUpStream.deltaCount,
    homeThirdTurnStreamDeltaCount: homeThirdTurnStream.deltaCount,
    homeFollowUpMessageCount: homeThirdTurn.bootstrap?.activeChat?.messages?.length || 0,
    homeFollowUpUserMessage:
      homeThirdTurn.bootstrap?.activeChat?.messages?.find(
        message => message.role === 'user' && message.content === homeThirdTurnPrompt,
      )?.content || null,
    homeFollowUpAssistantMessage:
      [...(homeThirdTurn.bootstrap?.activeChat?.messages || [])]
        .reverse()
        .find(message => message.role === 'assistant')?.content || null,
    continuityContextHasRules: continuityProbe.includes('Conversation continuity rules:'),
    continuityContextTreatsClarification: continuityProbe.includes(
      'The assistant\'s previous turn was a clarification/disambiguation step:',
    ),
    continuityContextCarriesTopic: continuityProbe.includes(
      'The topic being clarified came from the earlier user request: lancelot',
    ),
    continuityContextCarriesReply: continuityProbe.includes(
      'The latest user reply should be interpreted as choosing or refining that earlier topic: 亚瑟王',
    ),
    searchViewActive: searchViewBootstrap.settings.activeView,
    agentViewActive: agentViewBootstrap.settings.activeView,
    modelViewActive: modelViewBootstrap.settings.activeView,
    modelOptionsCount: (modelOptionsBootstrap.settings?.config?.availableModels || []).length,
    modelOptionHit:
      (modelOptionsBootstrap.settings?.config?.availableModels || []).find(
        item => item === 'gpt-5.5',
      ) || null,
    chatId,
    savedFile: saved.workspace?.selectedFile?.path || smokeFilePath,
    selectedFile: selected.workspace.selectedFile?.path || null,
    commandSuccess: Boolean(command.commandRun?.success),
    commandLabel: command.commandRun?.label || null,
    latestArtifact: artifact.artifacts?.[0]?.title || null,
    appliedFile: applied.workspace?.selectedFile?.path || null,
    assistantPreview: sent.assistantMessage?.content || null,
    codeStreamDeltaCount: sentStream.deltaCount,
    richStreamDeltaCount: richSentStream.deltaCount,
    graphCommandApprovalStatus: graphCommandApproval?.status || null,
    graphCommandApprovalTitle: graphCommandApproval?.title || null,
    graphExternalApprovalStatus: graphExternalApproval?.status || null,
    graphExternalApprovalTitle: graphExternalApproval?.title || null,
    richAttachmentKinds: (
      richSent.bootstrap?.activeChat?.messages?.find(
        message => message.content === 'Keep this resource for later',
      )?.attachments || []
    ).map(attachment => attachment.kind),
    searchFeatureHit:
      (featureSearch.search?.features || []).find(item => item.kind === 'feature')?.title || null,
    searchAgentHit:
      (agentFeatureSearch.search?.features || []).find(item => item.title === 'Agent')?.title || null,
    searchModelHit:
      (modelFeatureSearch.search?.features || []).find(item => item.title === 'Model')?.title || null,
    searchChatHit:
      (chatSearch.search?.chatHits || []).find(item => item.kind === 'chat-hit')?.title || null,
    searchFilePathHit:
      (searched.search?.files || []).find(item => item.filePath === smokeFilePath)?.filePath || null,
    searchFileContentHit:
      (fileContentSearch.hits || []).find(item => item.filePath === smokeFilePath)?.subtitle || null,
    mode: sent.bootstrap?.settings?.activeMode || null,
    enabledConnectors: sent.bootstrap?.settings?.enabledConnectorIds || [],
    externalConnector: externalConnector
      ? {
          name: externalConnector.name,
          status: externalConnector.config?.lastStatus || externalConnector.lastStatus || null,
          toolCount:
            externalConnector.config?.toolCount ||
            externalConnector.manifest?.tools?.length ||
            0,
          resourceCount:
            externalConnector.config?.resourceCount ||
            externalConnector.manifest?.resources?.length ||
            0,
          latestRun:
            externalConnector.config?.recentRuns?.[0]?.toolName || null,
        }
      : null,
    approvalStatus:
      approvalExecuted?.bootstrap?.approvals?.find(item => item.title === approvalTitle)?.status ||
      null,
    taskStatus:
      ranTask?.tasks?.find(item => item.id === task?.id)?.status || null,
    laneTaskStatus:
      ranLane?.tasks?.find(item => item.title === laneTaskTitle)?.status || null,
    importedPreset:
      importedPresetPayload?.customize?.agents?.find(agent => agent.id === 'main')?.identity || null,
    updatedAgentMood:
      updatedAgentPayload?.customize?.agents?.find(agent => agent.id === 'main')?.mood || null,
    updatedAgentToolCount:
      updatedAgentPayload?.customize?.agents?.find(agent => agent.id === 'main')?.toolCount || 0,
    updatedAgentModel:
      updatedAgentPayload?.customize?.agents?.find(agent => agent.id === 'main')?.model || null,
    updatedAgentSystemPrompt:
      updatedAgentPayload?.customize?.agents?.find(agent => agent.id === 'main')?.systemPrompt || null,
    selectedAgentId: updatedAgentPayload?.settings?.selectedAgentId || null,
    projectOverrideSource:
      projectOverridePayload?.customize?.agents?.find(agent => agent.id === 'main')?.scopeSource || null,
    agentIdentityPath: mainUpdatedAgent?.identityPath || null,
    agentSoulPath: mainUpdatedAgent?.soulPath || null,
    agentIdentityFileHasContent: Boolean(identityFileContent.trim()),
    agentSoulFileHasContent: Boolean(soulFileContent.trim()),
    agentIdentityMatches:
      Boolean(mainUpdatedAgent?.identity) &&
      identityFileContent.trim() === String(mainUpdatedAgent.identity).trim(),
    agentSoulMatches:
      Boolean(mainUpdatedAgent?.soulMd) &&
      soulFileContent.trim() === String(mainUpdatedAgent.soulMd).trim(),
    telegramRoundTripTitle,
    telegramRoundTripReply,
    telegramRoundTripAgentId,
    telegramRoundTripCount,
    telegramTypingCount,
    telegramImageRoundTripReply,
    telegramImageRoundTripCount,
  };

  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

main().catch(error => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
