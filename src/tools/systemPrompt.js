/**
 * Tool system prompt generator.
 *
 * Injects tool descriptions into the model's system prompt in ReAct/XML format
 * so any text-generating model (codex, api-key, local/Ollama) can call tools.
 *
 * Output format example injected into system prompt:
 *
 *   ## Available Tools
 *
 *   You may use the following tools by emitting <tool_call> blocks in your response.
 *   Always use valid JSON inside the block.
 *
 *   <tool_call>
 *   {"id":"call_001","name":"bash","arguments":{"command":"ls -la"}}
 *   </tool_call>
 *
 *   ### bash
 *   Execute a shell command...
 *   Parameters: { command: string (required), timeout?: number }
 *
 *   ...
 *
 *   Rules:
 *   - You may emit multiple <tool_call> blocks in a single response.
 *   - Wait for <tool_result> before continuing reasoning.
 *   - Only use tools when necessary.
 */

import { getToolsByCategory, getAllTools } from './registry.js';

// ─── Instruction header ───────────────────────────────────────────────────────

const TOOL_INSTRUCTION_HEADER = `\
## Available Tools

You have access to tools. To use a tool, emit a \`<tool_call>\` block containing a JSON object:

\`\`\`
<tool_call>
{"id":"<unique_id>","name":"<tool_name>","arguments":{<key>:<value>,...}}
</tool_call>
\`\`\`

Rules:
- You may emit one or more \`<tool_call>\` blocks per response.
- After emitting tool calls, stop and wait — do NOT continue until you see \`<tool_result>\` blocks.
- Write any reasoning or explanation BEFORE the \`<tool_call>\` blocks.
- Only call tools when they genuinely help answer the request.
- Never fabricate tool results.
- When a tool result contains a URL to a generated file (image, PDF, audio, etc.), copy that URL verbatim into your reply so the UI can render it inline as an attachment.
`;

// ─── Schema formatter ─────────────────────────────────────────────────────────

function formatParameterSchema(schema) {
  if (!schema || schema.type !== 'object' || !schema.properties) return '';

  const required = new Set(schema.required || []);
  const parts = [];

  for (const [key, def] of Object.entries(schema.properties)) {
    const req = required.has(key) ? ' (required)' : '';
    const type = def.type || 'any';
    const desc = def.description ? ` — ${def.description}` : '';
    parts.push(`  - \`${key}\`: ${type}${req}${desc}`);
  }

  return parts.join('\n');
}

function formatTool(tool) {
  const lines = [
    `### ${tool.id}`,
    tool.description,
  ];

  const params = formatParameterSchema(tool.parametersSchema);
  if (params) {
    lines.push('**Parameters:**');
    lines.push(params);
  }

  if (tool.examples?.length) {
    const ex = tool.examples[0];
    lines.push('**Example:**');
    lines.push(`\`\`\`\n<tool_call>\n${JSON.stringify({ id: 'call_001', name: tool.id, arguments: ex }, null, 2)}\n</tool_call>\n\`\`\``);
  }

  return lines.join('\n');
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Build the tools section to inject into the system prompt.
 *
 * @param {Object[]} [tools]  - optional override list; defaults to all registered tools
 * @returns {string}  - multi-line string ready to append to system prompt
 */
export function buildToolsSystemPrompt(tools) {
  const toolList = tools ?? getAllTools();
  if (!toolList.length) return '';

  // Group by category
  const byCategory = new Map();
  for (const tool of toolList) {
    const cat = tool.category || 'general';
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat).push(tool);
  }

  const sections = [TOOL_INSTRUCTION_HEADER];

  for (const [category, categoryTools] of byCategory) {
    const catLabel = category.charAt(0).toUpperCase() + category.slice(1);
    sections.push(`### Category: ${catLabel}`);
    for (const tool of categoryTools) {
      sections.push(formatTool(tool));
    }
  }

  return sections.join('\n\n');
}

/**
 * Returns true if the tools system prompt should be included for this request.
 * Currently always true when tools are registered, but this hook allows
 * mode-specific opt-out in the future.
 *
 * @param {Object} [options]
 * @param {string} [options.mode]  - chat mode id
 * @returns {boolean}
 */
export function shouldInjectToolsPrompt(options = {}) {
  return getAllTools().length > 0;
}
