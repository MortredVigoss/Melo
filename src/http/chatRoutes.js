import { serverText } from '../shared/serverText.js';
import { createRequestContext, requestIdentity } from '../runtime/requestContext.js';
import { validateChatRequest, errorPayload } from '../services/chat/requestContract.js';
import { sendChatMessage } from '../services/chat/sendChatMessage.js';
import { sendJson, startSse, writeSseEvent, readJsonBody } from './transport.js';
import { beginSupplements, addSupplement, endSupplements } from '../services/chat/supplements.js';
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

    // A supplement for the turn currently running in this chat (409 when none is).
    if (url.pathname === '/api/chat/supplement' && request.method === 'POST') {
      const body = await readJsonBody(request);
      const entry = addSupplement(String(body?.chatId || ''), body?.content);
      sendJson(response, entry ? 200 : 409, entry ? { id: entry.id } : { error: serverText('noActiveReply') });
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

      beginSupplements(body.chatId);
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

        writeSseEvent(response, 'done', { ...requestIdentity(context), ...payload, unusedSupplements: endSupplements(body.chatId).map(entry => entry.text) });
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
      } finally {
        // A stopped or failed turn takes no supplements with it into the next one.
        endSupplements(body.chatId);
      }
      return;
    }

}
