import test from 'node:test';
import assert from 'node:assert/strict';
import {parseReplyDocument,renderReplyDocument,replyPlainText,tableCells} from './replyDocument.js';
import {normalizeAssistantReplyForConversation} from '../src/services/message/messageBlocks.js';
const escape=s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
test('copy and display preserve list ordinals, nesting, checked state and code delimiters inside tables',()=>{
 assert.equal(replyPlainText('3. 第三步\n  4. 子步骤\n- [x] 完成'),'3. 第三步\n  4. 子步骤\n☑ 完成');
 assert.deepEqual(tableCells('| x | ``a|b`` |'),['x','``a|b``']);
 assert.deepEqual(tableCells('| x | ``a`|b`` |'),['x','``a`|b``']);
 assert.equal(replyPlainText('`__init__` 和 ``**literal**``'),'__init__ 和 **literal**');
 const html=renderReplyDocument('3. 第三步\n  4. 子步骤\n`__init__`',escape,escape);
 assert.match(html,/>3\.</);assert.match(html,/__init__/);assert.match(html,/<code>/);
});
test('replies render tables and common blocks without markdown debris while preserving literal code and pipes',()=>{
 const source='# 比较\n\n| 名称 | 结果 |\n| :--- | ---: |\n| A | **225** |\n| B | `a|b` |\n\n***\n- 已完成\n> 来源\n\n```sh\necho a | cat\n```';
 const blocks=parseReplyDocument(source);assert.equal(blocks[1].type,'table');assert.deepEqual(blocks[1].rows[2],['B','`a|b`']);
 const html=renderReplyDocument(source,escape,escape);assert.match(html,/<table/);assert.match(html,/>225</);assert.doesNotMatch(html,/\| :---|\*\*225|# 比较/);assert.match(html,/echo a \| cat/);
 assert.deepEqual(tableCells('| a\\|b | c |'),['a|b','c']);assert.equal(replyPlainText('正常 a | b'), '正常 a | b');
 assert.match(normalizeAssistantReplyForConversation(source).content,/`a\|b`/);
 assert.doesNotMatch(renderReplyDocument('| a | b |\n|---|---|\n|<img onerror=x>|&|',escape,escape),/<img/);
});
test('partial fences, setext headings and inline identifiers retain their meaning',()=>{
 assert.equal(parseReplyDocument('标题\n===')[0].type,'heading');
 assert.deepEqual(parseReplyDocument('```js\nconst n = a | b;')[0],{type:'code',language:'js',text:'const n = a | b;'});
 assert.equal(replyPlainText('`snake_case` 和 **重点**'), 'snake_case 和 重点');
});
