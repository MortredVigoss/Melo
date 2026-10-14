import test from 'node:test';import assert from 'node:assert/strict';
import {summarizeMessagePreview} from './conversation.js';
test('sidebar and project previews preserve numbered steps and code exactly once',()=>{
 const preview=summarizeMessagePreview({content:'3. Third\n4. Fourth\n\n`__init__`\n\n| Code | Value |\n| --- | --- |\n| ``a`|b`` | yes |'});
 assert.match(preview,/3\. Third 4\. Fourth/);assert.match(preview,/__init__/);assert.match(preview,/a`\|b/);assert.doesNotMatch(preview,/---/);
 assert.match(summarizeMessagePreview({blocks:[{type:'code',language:'python',text:'__init__'}]}),/__init__/);
});

import {summarizeProject,normalizeProject} from '../services/project/projectService.js';
test('shared project materials count once and deleted references disappear',()=>{
 const p={id:'p',knowledgeIds:['shared','own','gone']};
 assert.equal(summarizeProject(p,[],[{id:'shared'},{id:'own',projectId:'p'},{id:'gone',deletedAt:'2026-10-09'}]).artifactCount,2);
 const normalized=normalizeProject({summary:'',instructions:''},{sanitizeWorkspacePath:p=>p,fallbackWorkspaceRoot:'/tmp',defaultProjectTime:'2026-10-09'});
 assert.equal(normalized.summary,'');assert.equal(normalized.instructions,'');
});
