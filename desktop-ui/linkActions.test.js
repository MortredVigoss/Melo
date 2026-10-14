import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { copyLinkText, renderCopyLinkButton } from './linkActions.js';
import { renderAttachmentCards } from './attachmentCards.js';
import { extractTextUrls } from '../src/media/textUrls.js';
const escapeHtml = value => String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
const options = { escapeHtml, truncate: s => s, icon: { link: '', file: '' }, attachmentLabel: a => a.title || a.url, isPdfAttachment: () => false, extractTextUrls };

test('old malformed attachment renders the original Markdown destination and copy action', () => {
  const url = 'https://example.com/flights?sort=price_a&n=1';
  const message = { content: `[航班](${url})查看`, attachments: [{ kind: 'link', url: `${url})查看` }] };
  const document = new JSDOM(renderAttachmentCards(message, options)).window.document;
  assert.equal(document.querySelector('[data-external-url]').dataset.externalUrl, url);
  assert.equal(document.querySelector('[data-copy-link]').dataset.copyLink, url);
  assert.equal(message.attachments[0].url, `${url})查看`);
  assert.equal(renderCopyLinkButton('javascript:alert(1)', escapeHtml), '');
});

test('copy writes exact URL and falls back when WebKit denies async clipboard', async () => {
  const { document } = new JSDOM('<button id="original">copy</button>').window;
  document.querySelector('button').focus();
  const url = 'https://example.com/?x=1&y=2';
  let actual;
  await copyLinkText(url, { clipboard: { writeText: async text => { actual = text; } }, document });
  assert.equal(actual, url);
  document.execCommand = command => { assert.equal(command, 'copy'); actual = document.querySelector('textarea').value; return true; };
  await copyLinkText(url, { clipboard: { writeText: async () => { throw Error('denied'); } }, document });
  assert.equal(actual, url);
  assert.equal(document.activeElement.id, 'original');
  assert.equal(document.querySelector('textarea'), null);
  document.execCommand = () => false;
  await assert.rejects(copyLinkText(url, { clipboard: null, document }), /Clipboard unavailable/);
});
