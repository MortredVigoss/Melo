import { createRequestContext, requestIdentity } from '../runtime/requestContext.js';
import { validateChatRequest, errorPayload } from '../services/chat/requestContract.js';
import { sendChatMessage } from '../services/chat/sendChatMessage.js';
import { sendJson, startSse, writeSseEvent, readJsonBody } from './transport.js';
export async function handleChatRoutes(request, response, url) {
    if (url.pathname === '/api/chat/send' && request.method === 'POST') {
      const body = validateChatRequest(await readJsonBody(request));
      const abortController = new AbortController();
      const context = createRequestContext({ requestId: body.requestId, chatId: body.chatId, signal: abortController.signal });
      response.setHeader('x-request-id', context.requestId);
      response.setHeader('x-run-id', context.runId);
      const abortRequest = () => abortController.abort();
      request.once('aborted', abortRequest);
      response.once('close', () => {
        if (!response.writableFinished) {
          abortRequest();
        }
      });

      try {
        const payload = await sendChatMessage({
          ...body,
          context,
          signal: abortController.signal,
        });
        if (!response.writableEnded) {
          sendJson(response, 200, payload);
        }
      } catch (error) {
        if (abortController.signal.aborted) {
          response.destroy();
          return;
        }
        sendJson(response, error?.statusCode || 500, errorPayload(error, context));
      }
      return;
    }

    if (url.pathname === '/api/chat/send/stream' && request.method === 'POST') {
      const body = validateChatRequest(await readJsonBody(request));
      const abortController = new AbortController();
      const context = createRequestContext({ requestId: body.requestId, chatId: body.chatId, signal: abortController.signal });
      response.setHeader('x-request-id', context.requestId);
      response.setHeader('x-run-id', context.runId);
      const abortRequest = () => abortController.abort();
      request.once('aborted', abortRequest);
      response.once('close', () => {
        if (!response.writableFinished) {
          abortRequest();
        }
      });

      startSse(response);
      writeSseEvent(response, 'started', {
        ...requestIdentity(context),
        requestId: context.requestId,
      });

      try {
        const payload = await sendChatMessage({
          ...body,
          context,
          signal: abortController.signal,
          onDelta: async chunk => {
            writeSseEvent(response, 'delta', { ...requestIdentity(context), ...chunk });
          },
          onReasoningDelta: async chunk => {
            writeSseEvent(response, 'reasoning', { ...requestIdentity(context), ...chunk });
          },
          sseEmitter: (event, data) => {
            writeSseEvent(response, event, data);
          },
        });

        writeSseEvent(response, 'done', { ...requestIdentity(context), ...payload });
        response.end();
      } catch (error) {
        if (abortController.signal.aborted) {
          writeSseEvent(response, 'aborted', {
            ...requestIdentity(context),
            ok: true,
          });
          response.end();
          return;
        }

        writeSseEvent(response, 'error', errorPayload(error, context));
        response.end();
      }
      return;
    }

}
