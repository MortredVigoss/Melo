// Regression tests for the dynamic-context block — specifically that
// soft-deleted artifacts never reach the prompt.  Codex 2026-04-27 🟠
// audit: a tombstoned artifact still flowed through `connectors.some
// (artifacts && enabled)` into the next turn's prompt; that's a
// privacy + correctness regression because the user already "deleted"
// the row in the UI.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDynamicContext,
  buildSelectedFileContextBlock,
} from './dynamicContext.js';

function chatFixture({ id = 'chat-1', projectId = 'proj-1', messages = [] } = {}) {
  return { id, projectId, messages };
}

const EMPTY_WORKSPACE = {
  selectedFile: null,
  entries: [],
  rootPath: '/tmp/x',
  exists: false,
  fileCount: 0,
  selectedFilePath: null,
  commandRuns: [],
};

const ARTIFACT_CONNECTOR_ENABLED = [{ id: 'artifacts', enabled: true }];
const LOCAL_FILES_CONNECTOR_ENABLED = [{ id: 'local-files', enabled: true }];

test('independent chats never share artifacts or command results merely because both project IDs are empty', async () => {
  for (const projectId of [null, undefined]) {
    const state = {
      artifacts: [{id:'own',chatId:'chat-1',projectId,title:'Own',content:'OWN_BODY'}, {id:'other',chatId:'other',projectId,title:'Other',content:'OTHER_BODY'}],
      commandRuns: [{chatId:'chat-1',projectId,label:'Own command',output:'OWN_COMMAND'}, {chatId:'other',projectId,label:'Other command',output:'OTHER_COMMAND'}],
    };
    const out = await buildDynamicContext(state, {id:'chat-1',projectId,messages:[]}, EMPTY_WORKSPACE, [...ARTIFACT_CONNECTOR_ENABLED,{id:'local-command',enabled:true}]);
    assert.match(out,/OWN_BODY/); assert.match(out,/OWN_COMMAND/);
    assert.doesNotMatch(out,/OTHER_BODY|OTHER_COMMAND/);
  }
});

test('buildDynamicContext: live artifacts surface in the "Recent artifacts" block', async () => {
  const state = {
    artifacts: [
      { id: 'a-live', chatId: 'chat-1', projectId: 'proj-1', title: 'Live Note', content: 'visible body' },
    ],
    commandRuns: [],
  };
  const out = await buildDynamicContext(
    state,
    chatFixture(),
    EMPTY_WORKSPACE,
    ARTIFACT_CONNECTOR_ENABLED,
  );
  assert.match(out, /Recent artifacts/);
  assert.match(out, /Live Note/);
  assert.match(out, /visible body/);
});

test('buildDynamicContext: soft-deleted artifacts are filtered out', async () => {
  const state = {
    artifacts: [
      { id: 'a-tomb', chatId: 'chat-1', projectId: 'proj-1', title: 'Tombstone Note',
        content: 'should never reach prompt', deletedAt: '2026-04-27T00:00:00.000Z' },
    ],
    commandRuns: [],
  };
  const out = await buildDynamicContext(
    state,
    chatFixture(),
    EMPTY_WORKSPACE,
    ARTIFACT_CONNECTOR_ENABLED,
  );
  // No live artifacts at all → no "Recent artifacts" block at all.
  assert.doesNotMatch(out, /Recent artifacts/);
  assert.doesNotMatch(out, /Tombstone Note/);
  assert.doesNotMatch(out, /should never reach prompt/);
});

test('buildDynamicContext: live artifacts pass through, tombstones drop', async () => {
  const state = {
    artifacts: [
      { id: 'a-tomb', chatId: 'chat-1', projectId: 'proj-1', title: 'Tomb', content: 'tomb body', deletedAt: '2026-04-27T00:00:00.000Z' },
      { id: 'a-live', chatId: 'chat-1', projectId: 'proj-1', title: 'Live',  content: 'live body' },
    ],
    commandRuns: [],
  };
  const out = await buildDynamicContext(
    state,
    chatFixture(),
    EMPTY_WORKSPACE,
    ARTIFACT_CONNECTOR_ENABLED,
  );
  assert.match(out, /Recent artifacts/);
  assert.match(out, /Live/);
  assert.match(out, /live body/);
  assert.doesNotMatch(out, /Tomb body/);
  // The literal "Tomb" title must not appear either.  Use a tighter
  // pattern so a substring of "Live"/"livestone" wouldn't match.
  assert.doesNotMatch(out, /- Tomb:/);
});

test('buildDynamicContext: artifacts connector disabled → no artifact block, even with live rows', async () => {
  const state = {
    artifacts: [{ id: 'a', chatId: 'chat-1', projectId: 'proj-1', title: 'Live', content: 'body' }],
    commandRuns: [],
  };
  const out = await buildDynamicContext(
    state,
    chatFixture(),
    EMPTY_WORKSPACE,
    [{ id: 'artifacts', enabled: false }],
  );
  assert.doesNotMatch(out, /Recent artifacts/);
  assert.doesNotMatch(out, /Live/);
});

test('buildSelectedFileContextBlock: small files keep full content for compatibility', () => {
  const out = buildSelectedFileContextBlock({
    path: 'src/small.js',
    language: 'javascript',
    content: 'export const answer = 42;\nconsole.log(answer);\n',
  }, 'review this file');

  assert.match(out, /Selected workspace file: src\/small\.js/);
  assert.match(out, /export const answer = 42/);
  assert.match(out, /console\.log\(answer\)/);
  assert.doesNotMatch(out, /optimized for token budget/);
});

test('buildSelectedFileContextBlock: large files include query-relevant excerpts instead of full content', () => {
  const lines = Array.from({ length: 260 }, (_, index) => `const filler${index + 1} = ${index + 1};`);
  lines[180] = 'export function suspiciousTokenRegressionGuard() { return "needle"; }';
  lines[250] = 'const distantTailThatShouldNotBeIncluded = true;';

  const out = buildSelectedFileContextBlock({
    path: 'src/large.js',
    language: 'javascript',
    content: lines.join('\n'),
  }, 'review suspiciousTokenRegressionGuard');

  assert.match(out, /optimized for token budget/);
  assert.match(out, /181\texport function suspiciousTokenRegressionGuard/);
  assert.doesNotMatch(out, /distantTailThatShouldNotBeIncluded/);
});

test('buildDynamicContext: local file context uses optimized excerpts for large selected files', async () => {
  const lines = Array.from({ length: 240 }, (_, index) => `line ${index + 1}: filler`);
  lines[119] = 'line 120: targetReviewNeedle lives here';

  const out = await buildDynamicContext(
    { artifacts: [], commandRuns: [] },
    chatFixture(),
    {
      ...EMPTY_WORKSPACE,
      selectedFile: {
        path: 'src/review-target.js',
        language: 'javascript',
        content: lines.join('\n'),
      },
      entries: [{ type: 'file', path: 'src/review-target.js' }],
    },
    LOCAL_FILES_CONNECTOR_ENABLED,
    'please review targetReviewNeedle',
  );

  assert.match(out, /Selected workspace file: src\/review-target\.js/);
  assert.match(out, /120\tline 120: targetReviewNeedle lives here/);
  assert.match(out, /Workspace snapshot/);
  assert.doesNotMatch(out, /240\tline 240: filler/);
});

test('buildSelectedFileContextBlock: truncated UI preview surfaces a header note', () => {
  // The selectedFile shape carries a `truncated` flag when the IDE
  // already capped the preview before the prompt was assembled.
  // The block must surface that to the model so it doesn't assume
  // the visible text is the entire file.
  const out = buildSelectedFileContextBlock({
    path: 'src/big.js',
    language: 'javascript',
    content: 'export const x = 1;\n',
    truncated: true,
  }, 'review');
  assert.match(out, /UI preview was already truncated/);
});

test('buildSelectedFileContextBlock: multi-language keyword scoring prioritizes Python def line', () => {
  // Codex review #11/#12 P3 known-limit closure: original code-keyword
  // regex `function|class|const|let|var|export|import|async|test|
  // describe|it(` was JS/TS-only and missed Python `def` / Rust `fn`
  // / Go `func` / Java `public static` / etc. Verify the +2 keyword
  // bonus now applies to Python source (def line should outrank a
  // plain comment line containing the same query token).
  const lines = Array.from({ length: 240 }, (_, i) => `# this is a long comment line about query word at position ${i}`);
  // Plant the def line (with token "needle") deep in the file.
  // Without the bonus, the comment line containing "needle" near
  // the file head wins. With the bonus, def line outranks comments.
  lines[5] = '# early comment containing needle keyword early';
  lines[180] = 'def needleHandler(self, args):';
  // Pad to push past 3000 char threshold for snippet mode.
  const out = buildSelectedFileContextBlock({
    path: 'src/handler.py',
    language: 'python',
    content: lines.join('\n'),
  }, 'review needleHandler');
  assert.match(out, /optimized for token budget/);
  // The def line at line 181 (0-indexed 180) should win the seed
  // selection because of the +2 keyword bonus + +1 early-position
  // bonus on `def` (first 12 chars).
  assert.match(out, /181\tdef needleHandler/);
});

test('buildSelectedFileContextBlock: multi-language Rust fn / Go func / Java public class also score', () => {
  // Spot-check several languages — each line that contains the query
  // token AND a code keyword should score higher than a comment line
  // with the same token. We verify the def/fn/func line is included
  // in the rendered excerpt.
  const langCases = [
    {
      path: 'src/parser.rs',
      lang: 'rust',
      keyword: 'fn',
      hot: 'fn parseTokens(input: &str) -> Result<Vec<Token>, Error> {',
    },
    {
      path: 'src/main.go',
      lang: 'go',
      keyword: 'func',
      hot: 'func parseTokens(input string) ([]Token, error) {',
    },
    {
      path: 'src/Parser.java',
      lang: 'java',
      keyword: 'public',
      hot: 'public static List<Token> parseTokens(String input) {',
    },
    {
      path: 'src/Parser.swift',
      lang: 'swift',
      keyword: 'func',
      hot: 'func parseTokens(_ input: String) -> [Token] {',
    },
  ];
  for (const { path, lang, keyword, hot } of langCases) {
    const lines = Array.from({ length: 240 }, (_, i) => `# comment about parseTokens at ${i}`);
    lines[5] = `# early comment containing parseTokens word here`;
    lines[180] = hot;
    const out = buildSelectedFileContextBlock({
      path,
      language: lang,
      content: lines.join('\n'),
    }, 'review parseTokens function');
    // The line with the language keyword should be in the rendered
    // excerpt (line index 180 = display line 181).
    assert.match(
      out,
      new RegExp(`181\\t${keyword.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}`),
      `${lang}: hot line with ${keyword} must be selected as top seed`,
    );
  }
});

test('buildSelectedFileContextBlock: Kotlin fun / Ruby def keyword bonus also applies', () => {
  // Codex review #14 ⚪ P2: original multi-language test covered
  // Python/Rust/Go/Java/Swift but skipped Kotlin and Ruby. Pin them
  // here so the regex's full coverage is locked in.
  for (const { path, lang, hot } of [
    {
      path: 'src/Service.kt',
      lang: 'kotlin',
      hot: 'fun parseTokens(input: String): List<Token> {',
    },
    {
      path: 'src/parser.rb',
      lang: 'ruby',
      hot: 'def parseTokens(input)',
    },
  ]) {
    const lines = Array.from({ length: 240 }, (_, i) => `# comment about parseTokens at ${i}`);
    lines[5] = `# early comment containing parseTokens word here`;
    lines[180] = hot;
    const out = buildSelectedFileContextBlock({
      path,
      language: lang,
      content: lines.join('\n'),
    }, 'review parseTokens function');
    assert.match(
      out,
      /181\t(?:fun|def) parseTokens/,
      `${lang}: hot line with keyword must be selected as top seed`,
    );
  }
});

test('buildSelectedFileContextBlock: word-boundary regression — `asynchronization` does NOT match `async`', () => {
  // Codex review #14 ⚪ P2 regression pin: the multi-lang regex
  // added \b boundary specifically to prevent substring matches
  // (e.g. `asynchronization`, `transformative`, `interfaceable`).
  // Construct a file where the only occurrences of "async" are
  // INSIDE longer words; the keyword bonus must NOT apply.
  // We can't directly assert "no bonus" via the public API, but we
  // can verify behavior: a line with only the substring (no real
  // keyword) should not outrank a comment line with the same query
  // token at an earlier position.
  const lines = Array.from({ length: 240 }, (_, i) => `# baseline filler at ${i}`);
  lines[5] = '# token-needle at line 6 (comment, baseline)';
  lines[180] = 'asynchronization is the act of de-syncing token-needle';
  // No real `async` keyword (boundary blocks substring); no actual
  // code structure on line 181. Both lines have the token "needle"
  // (or "token-needle") + 1 has substring "async" inside word.
  // The early-position bonus (+1 first-12-chars) on line 6 should
  // win — line 6 is selected before line 181.
  const out = buildSelectedFileContextBlock({
    path: 'src/notes.md',
    language: 'markdown',
    content: lines.join('\n'),
  }, 'review needle');
  // Verify line 6 is in excerpt (token-needle there).
  assert.match(out, /6\t# token-needle/);
  // Optional: line 181 substring "asynchronization" is NOT given
  // the +2 keyword bonus, so it doesn't dominate ranking. Behavior
  // pin is implicit (line 6 won the seed; if substring-match were
  // active, line 181 would have +4+2+0=6 vs line 6's +4+0+1=5 and
  // line 181 would win; line 6 winning means the bonus is gated by
  // word boundary correctly).
});

test('buildSelectedFileContextBlock: empty / stop-word-only query falls back to file head', () => {
  // When tokenizeContextQuery returns no useful tokens (empty
  // message, or only stop words like "看看 一下 帮我"), no line
  // scores positive — the block must still render something. Falls
  // back to seed=[0] so the model gets the file head, which is
  // typically imports + opening declarations.
  // Fixture needs > SELECTED_FILE_FULL_CONTEXT_CHARS (3000) to
  // trigger the snippet path; pad each line to make the total large.
  const lines = Array.from(
    { length: 300 },
    (_, i) => `const veryLongIdentifier${i + 1} = "padding-padding-padding-${i + 1}";`,
  );
  const out = buildSelectedFileContextBlock({
    path: 'src/file.js',
    language: 'javascript',
    content: lines.join('\n'),
  }, '看看 一下 帮我');  // all stop words → 0 tokens
  assert.match(out, /optimized for token budget/);
  // Head excerpt: line 1 should be present, deep tail should not.
  assert.match(out, /1\tconst veryLongIdentifier1 =/);
  assert.doesNotMatch(out, /300\tconst veryLongIdentifier300/);
});

test('Agent capabilities control local context even when old global connector toggles disagree',async()=>{
 const state={projects:[],agentProfiles:{main:{capabilities:{version:1,readFiles:false,runCommands:false}}},artifacts:[],commandRuns:[{chatId:'chat-1',label:'command',output:'command-secret'}]};
 const workspace={...EMPTY_WORKSPACE,selectedFile:{path:'secret.txt',content:'file-secret'},entries:[{type:'file',path:'secret.txt'}]};
 const connectors=[{id:'local-files',enabled:true},{id:'local-command',enabled:true}];
 assert.doesNotMatch(await buildDynamicContext(state,chatFixture({projectId:null}),workspace,connectors),/file-secret|command-secret/);
 state.agentProfiles.main.capabilities.readFiles=true;state.agentProfiles.main.capabilities.runCommands=true;
 const out=await buildDynamicContext(state,chatFixture({projectId:null}),workspace,connectors.map(c=>({...c,enabled:false})));
 assert.match(out,/file-secret/);assert.match(out,/command-secret/);
});
