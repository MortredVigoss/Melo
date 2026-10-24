import test from 'node:test';import assert from 'node:assert/strict';
import {buildImagePromptText,parseImageReview,MAX_IMAGE_REQUEST_CHARS} from './imagePrompts.js';

test('brief preserves exact multilingual text and role boundaries without adding an edit constraint to new images',()=>{
  const request='把标题写成“Melo | 2026”，换成横版。\n保留中文，不添加其他文字。';
  const brief=buildImagePromptText({userPrompt:request,action:'generate',referenceRoles:['style','subject']});
  assert.ok(brief.includes(request));assert.match(brief,/Image 1: visual style/);assert.match(brief,/Image 2: subject identity/);
  assert.match(brief,/does not freeze/);assert.doesNotMatch(brief,/Only change the attributes/);
});
test('maximum user request fits Images API with a bounded, explicitly partial analysis',()=>{
  const text='词'.repeat(MAX_IMAGE_REQUEST_CHARS-10)+'最后保持原样';
  const brief=buildImagePromptText({userPrompt:text,action:'edit',editSpec:'observation '.repeat(1000),referenceRoles:Array(16).fill('subject'),masked:true});
  assert.ok(brief.includes(text));assert.ok(brief.length<=32000);assert.match(brief,/Partial reference excerpt/);assert.match(brief,/transparent mask regions/);
});
test('unparseable, contradictory and evidence-free reviews never become a pass',()=>{
  for(const raw of ['Everything is perfect!', '{}', JSON.stringify({verdict:'matched',changes:[],preserved:[],issues:[]}), JSON.stringify({verdict:'matched',changes:[],preserved:[],issues:['文字错误']})])assert.equal(parseImageReview(raw).verdict,'uncertain');
  assert.equal(parseImageReview(JSON.stringify({verdict:'mismatch',changes:['颜色正确'],preserved:['布局'],issues:['多出一个节点']})).verdict,'mismatch');
});
