import { createServer } from 'node:http';

// Receive only synthetic reports while the test APK is alive. Loopback plus a
// per-run identifier avoids stale filesystem output and APK uninstall timing.
export async function createAndroidTaskCollector(evaluationId) {
  if (typeof evaluationId !== 'string' || evaluationId.length < 8) throw Error('A per-run identifier is required.');
  let report;
  const server = createServer(async (request, response) => {
    const reply = status => { response.writeHead(status); response.end(); };
    if (request.method !== 'POST' || request.url !== '/task-eval') return reply(404);
    if (request.headers['x-melo-evaluation'] !== evaluationId) return reply(403);
    if (report) return reply(409);
    try {
      let size = 0; const chunks = [];
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 2_000_000) return reply(413);
        chunks.push(chunk);
      }
      const candidate = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (candidate.evaluationId !== evaluationId || candidate.version !== 1 || candidate.host !== 'Android-JavaScriptSandbox' || candidate.report?.passed !== true) return reply(422);
      // Two uploads may overlap while their bodies arrive. Recheck at commit.
      if (report) return reply(409);
      report = candidate;
      reply(204);
    } catch { reply(400); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { port: server.address().port,
    read() { if (!report) throw Error('The emulator did not deliver a passing task report for this run.'); return report; },
    async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); },
  };
}
