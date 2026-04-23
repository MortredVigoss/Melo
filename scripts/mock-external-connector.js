import { createServer } from 'node:http';

const MAX_BODY_BYTES = 1024 * 1024;

function getArgValue(flag, fallback) {
  const index = process.argv.indexOf(flag);
  if (index >= 0 && process.argv[index + 1]) {
    return process.argv[index + 1];
  }

  return fallback;
}

const host = getArgValue('--host', '127.0.0.1');
const port = Number(getArgValue('--port', '43131'));

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
  });
  response.end(`${JSON.stringify(payload)}\n`);
}

async function readJsonBody(request) {
  const chunks = [];
  let totalBytes = 0;

  for await (const chunk of request) {
    totalBytes += chunk.length;
    if (totalBytes > MAX_BODY_BYTES) {
      const error = new Error(`Request body exceeded ${MAX_BODY_BYTES} bytes.`);
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }

  if (!chunks.length) {
    return {};
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const error = new Error('Request body was not valid JSON.');
    error.statusCode = 400;
    throw error;
  }
}

const manifestPayload = Object.freeze({
  name: 'Smoke MCP',
  tools: [
    {
      id: 'docs.search',
      name: 'docs.search',
      description: 'Search smoke documentation context.',
    },
    {
      id: 'notes.fetch',
      name: 'notes.fetch',
      description: 'Fetch stored smoke-note context.',
    },
  ],
  resources: [
    {
      id: 'docs://smoke/readme',
      name: 'Smoke README',
      description: 'A synthetic readme resource for smoke testing.',
    },
  ],
  prompts: [
    {
      id: 'triage',
      name: 'triage',
      description: 'Help triage build and debugging issues.',
    },
  ],
});

const routes = new Map([
  [
    '/health',
    async () => ({
      statusCode: 200,
      payload: { ok: true, name: 'Smoke MCP' },
    }),
  ],
  [
    '/manifest',
    async () => ({
      statusCode: 200,
      payload: manifestPayload,
    }),
  ],
  [
    '/context',
    async request => {
      const body = await readJsonBody(request);
      const selectedFile = body?.selectedFile?.path || '(none)';
      const projectName = body?.project?.name || 'Unknown project';
      const query = body?.query || '';

      return {
        statusCode: 200,
        payload: {
          context: [
            `Connector project: ${projectName}`,
            `Selected file: ${selectedFile}`,
            `User query: ${query}`,
            'Smoke MCP suggests checking docs.search before making structural refactors.',
          ].join('\n'),
        },
      };
    },
  ],
  [
    '/resource',
    async request => {
      const body = await readJsonBody(request);
      const resourceId = body?.resourceId || 'docs://smoke/readme';

      return {
        statusCode: 200,
        payload: {
          title: resourceId,
          content: [
            '# Smoke Resource',
            '',
            `Resource: ${resourceId}`,
            'This synthetic resource is returned by the mock MCP connector.',
          ].join('\n'),
        },
      };
    },
  ],
  [
    '/prompt',
    async request => {
      const body = await readJsonBody(request);
      const promptId = body?.promptId || 'triage';

      return {
        statusCode: 200,
        payload: {
          title: `Prompt: ${promptId}`,
          content: [
            `Prompt template: ${promptId}`,
            'Use this prompt to triage build and debugging issues before deeper tool use.',
          ].join('\n\n'),
        },
      };
    },
  ],
  [
    '/invoke',
    async request => {
      const body = await readJsonBody(request);
      const toolName = body?.tool || 'unknown.tool';
      const query = body?.input?.query || body?.input?.topic || 'none';
      const projectName = body?.project?.name || 'Unknown project';

      return {
        statusCode: 200,
        payload: {
          ok: true,
          output: [
            `Tool: ${toolName}`,
            `Project: ${projectName}`,
            `Query: ${query}`,
            'Smoke MCP invocation completed successfully.',
          ].join('\n'),
        },
      };
    },
  ],
]);

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || '/', `http://${host}:${port}`);
    const handler = routes.get(url.pathname);
    if (!handler) {
      sendJson(response, 404, { error: 'Not found' });
      return;
    }

    const result = await handler(request, url);
    sendJson(response, result.statusCode, result.payload);
  } catch (error) {
    sendJson(response, error.statusCode || 500, {
      error: error.message || 'Mock connector request failed.',
    });
  }
});

server.listen(port, host, () => {
  process.stdout.write(`Mock external connector listening at http://${host}:${port}\n`);
});

function shutdown() {
  server.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
