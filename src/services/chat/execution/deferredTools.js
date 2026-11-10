// Deferred tool definitions for the lead (2026-11-10 latency audit L4).
//
// The lead used to send every tool definition with every request: 82 tools and
// about 46 000 input tokens on the measured desktop setup, two thirds of them
// the schemas of MCP servers (27 chart tools, 22 browser tools) that most
// turns never touch. Here the lead keeps the built-in tools, skills and the
// router in full; MCP tools are listed by name with one line each inside a
// single `load_tools` tool, and the lead asks for a definition before it uses
// one. Loading runs nothing: the host adds the definitions to the following
// requests of the same turn. Capability scope, approvals and the visible-tool
// list are unchanged, so a loaded tool is dispatched exactly as before.
//
// Members are not affected: a member only ever receives its own few tools.
import { compileFunctionTool } from '../../../tools/functionSchema.js';

export const LOAD_TOOLS_NAME = 'load_tools';
// Deferring is only worth a possible extra round when the definitions are large.
export const DEFERRED_MIN_TOOLS = 6;
export const DEFERRED_MIN_CHARS = 16000;
const MAX_NAMES = 24;

function oneLine(text) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  const sentence = flat.match(/^.*?[.。!?！？](?=\s|$)/u)?.[0] || flat;
  return sentence.length > 110 ? sentence.slice(0, 107).trimEnd() + '…' : sentence;
}

/**
 * Split a lead tool list into the tools whose definitions go out with every
 * request and the MCP tools that are loaded on demand. Returns null when
 * deferring does not apply (text tool protocol, switched off, or too little
 * to save), in which case the caller keeps its list unchanged.
 */
export function createToolDeferral(tools = [], { enabled = true, native = true } = {}) {
  if (!enabled || !native) return null;
  const entries = [];
  for (const tool of tools) {
    if (typeof tool?.id !== 'string' || !tool.id.startsWith('mcp:')) continue;
    let compiled;
    try { compiled = compileFunctionTool(tool); } catch { continue; }
    if (compiled.schemaError) continue;
    entries.push({ tool, name: compiled.definition.name, chars: JSON.stringify(compiled.definition).length });
  }
  const savedChars = entries.reduce((sum, entry) => sum + entry.chars, 0);
  if (entries.length < DEFERRED_MIN_TOOLS || savedChars < DEFERRED_MIN_CHARS) return null;
  const deferredIds = new Set(entries.map(entry => entry.tool.id));
  const byName = new Map();
  for (const entry of entries) { byName.set(entry.name, entry.tool); byName.set(entry.tool.id, entry.tool); }
  const pending = new Set(deferredIds);
  // The list stays the same for the whole turn so the request prefix before it keeps its provider cache.
  const loaderTool = Object.freeze({ id: LOAD_TOOLS_NAME, name: LOAD_TOOLS_NAME, effect: 'compute', requiresPermission: false,
    description: 'The tools listed below are available in this conversation, but their definitions are not loaded, to keep requests small. To use one, first call load_tools with the exact names you need; '
      + 'their definitions are added and you call them in your next step. Loading runs nothing and needs no approval. Load only what the task needs, and never tell the user a listed tool is unavailable.\n'
      + entries.map(entry => `- ${entry.name}: ${oneLine(entry.tool.description)}`).join('\n'),
    parametersSchema: { type: 'object', additionalProperties: false, required: ['names'],
      properties: { names: { type: 'array', minItems: 1, maxItems: MAX_NAMES, items: { type: 'string' }, description: 'Exact tool names from the list.' } } } });
  return {
    loaderTool,
    savedChars,
    /** Tools that keep their full definition in every request, in their original order. */
    active: tools.filter(tool => !deferredIds.has(tool?.id)),
    /** Every deferred tool, loaded or not, for declarations that must cover the whole turn. */
    deferred: entries.map(entry => entry.tool),
    /** True while `name` (wire name or id) is a listed tool whose definition is not loaded yet. */
    isPending(name) { const tool = byName.get(name); return !!tool && pending.has(tool.id); },
    /** Move the named tools into the loaded set; the report is the tool result the model reads. */
    load(names) {
      const requested = [...new Set((Array.isArray(names) ? names : []).filter(name => typeof name === 'string').map(name => name.trim()).filter(Boolean))].slice(0, MAX_NAMES);
      const loaded = [], already = [], unknown = [];
      for (const name of requested) {
        const tool = byName.get(name);
        if (!tool) unknown.push(name.slice(0, 120));
        else if (pending.delete(tool.id)) loaded.push(tool);
        else already.push(name);
      }
      const named = list => list.map(tool => entries.find(entry => entry.tool.id === tool.id).name);
      const report = { loaded: named(loaded), ...(already.length ? { alreadyLoaded: already } : {}), ...(unknown.length ? { unknown, hint: 'Use the exact names from the load_tools list.' } : {}),
        next: loaded.length || already.length ? 'These tools are now callable: call them in your next step.' : 'Nothing was loaded.' };
      return { loaded, ok: loaded.length + already.length > 0, report: JSON.stringify(report) };
    },
  };
}
