import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { buildAgentProfilePatch } from './agentProfilePatch.js';
import { renderAttachmentCards } from './attachmentCards.js';
import { createScrollPreservation } from './scrollPreservation.js';
import { createSearchPageRenderer } from './searchPage.js';
import { renderRuntimePanel } from './runtimePanel.js';
import { describeAudioExtractionStatus, describeVideoExtractionStatus } from './videoStatus.js';

const escapeHtml = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
const truncate = (value, length) => String(value).slice(0, length);

test('a voice-only form creates a narrow patch and preserves unrelated name/role/channel fields', () => {
  const dom = new JSDOM('<form><input name="minimaxVoiceId" value="new-voice"><input name="ttsSpeed" value="1.2"></form>');
  const form = dom.window.document.querySelector('form');
  assert.deepEqual(buildAgentProfilePatch(form, new dom.window.FormData(form)), { minimaxVoiceId: 'new-voice', ttsSpeed: 1.2 });
  dom.window.close();
});

test('clearing a name is distinct from a form that never submitted the name', () => {
  const dom = new JSDOM('<form><input name="name" value=""><textarea name="rolePrompt">New role</textarea></form>');
  const form = dom.window.document.querySelector('form');
  assert.deepEqual(buildAgentProfilePatch(form, new dom.window.FormData(form)), { name: '', rolePrompt: 'New role', _clearedFields: ['name'] });
  dom.window.close();
});

test('social video links retain clickable preview cards instead of an empty video player', () => {
  const attachment = { id: 'a', kind: 'video', url: 'https://v.douyin.com/test/', title: 'Share' };
  const message = { attachments: [attachment], extractedMedia: [{ attachmentId: 'a', text: 'Visible caption', metadata: { source: 'social-link:share-preview', title: 'Video title' } }] };
  const html = renderAttachmentCards(message, { escapeHtml, truncate, icon: { link: '', file: '' }, attachmentLabel: a => a.title, isPdfAttachment: () => false, describeAudioExtractionStatus, describeVideoExtractionStatus });
  assert.match(html, /data-external-url="https:\/\/v.douyin.com\/test\/"/);
  assert.match(html, /Visible caption/);
  assert.doesNotMatch(html, /<video/);
});

test('search file groups keep their expanded state and exact line navigation after extraction', () => {
  const item = { id: 'f', title: 'test.js', filePath: 'test.js', kind: 'file', hits: [{ lineNumber: 42, lineText: '<script>' }] };
  const uiState = { searchQuery: 'test', expandedSearchGroups: {} };
  const renderer = createSearchPageRenderer({ uiState, escapeHtml, truncate, icon: {}, searchResultIcon: () => '', currentSearchItems: () => [item], searchBucketsForRender: () => [{ title: 'Files', items: [item] }] });
  assert.doesNotMatch(renderer.renderSearchPage(), /data-line-number="42"/);
  uiState.expandedSearchGroups['test.js'] = true;
  const html = renderer.renderSearchPage();
  assert.match(html, /data-line-number="42"/);
  assert.match(html, /&lt;script>/);
});

test('scroll positions survive DOM replacement and bottom-follow does not restore an old anchor', () => {
  const markup = '<div class="customize-pane"></div><form id="agent"><textarea name="rolePrompt"></textarea></form><div class="thread-scroll-region"><article class="message" data-message-id="one"></article></div>';
  const dom = new JSDOM(markup);
  const { document } = dom.window;
  const helpers = createScrollPreservation(dom.window);
  document.querySelector('.customize-pane').scrollTop = 400;
  document.querySelector('textarea').scrollTop = 70;
  const positions = helpers.captureScrollPositions();
  const textareas = helpers.captureFormTextareaScrolls();
  document.body.innerHTML = markup;
  helpers.restoreScrollPositions(positions);
  helpers.restoreFormTextareaScrolls(textareas);
  assert.equal(document.querySelector('.customize-pane').scrollTop, 400);
  assert.equal(document.querySelector('textarea').scrollTop, 70);
  const scroller = document.querySelector('.thread-scroll-region');
  Object.defineProperties(scroller, { scrollHeight: { value: 1000 }, clientHeight: { value: 400 } });
  scroller.scrollTop = 600;
  assert.equal(helpers.captureThreadAnchor(scroller), null);
  dom.window.close();
});

test('runtime panel displays evidence level and escapes paths without changing other panels', () => {
  assert.match(renderRuntimePanel(null, escapeHtml), /尚未确认/);
  const html = renderRuntimePanel({ paths: { home: '<private>' }, capabilities: [{ id: 'video', status: 'yellow', level: 'preview', reason: 'partial-evidence' }] }, escapeHtml);
  assert.match(html, /待验证/);
  assert.match(html, /preview/);
  assert.match(html, /&lt;private>/);
  assert.doesNotMatch(html, /<private>/);
});
