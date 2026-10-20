import {delegateTool,delegateTask} from '../agents/delegate.js';
/**
 * Tool registry.
 *
 * Central store for all available tools.
 * Tools are registered once at startup; looked up by id at call time.
 *
 * Handles:
 *   - Validation and normalization on registration
 *   - Category grouping for system prompt injection
 *   - Lookup by id
 */

import { registerTools } from './registryCore.js';
import { bashTool } from './builtins/bashTool.js';
import { fileReadTool } from './builtins/fileReadTool.js';
import { fileEditTool } from './builtins/fileEditTool.js';
import { fileWriteTool } from './builtins/fileWriteTool.js';
import { fileDeleteTool } from './builtins/fileDeleteTool.js';
import { fileMoveTool } from './builtins/fileMoveTool.js';
import { fileMkdirTool } from './builtins/fileMkdirTool.js';
import { globTool } from './builtins/globTool.js';
import { grepTool } from './builtins/grepTool.js';
import { agentTool } from '../agents/subAgent.js';
import { fetchUrlTool } from './builtins/fetchUrlTool.js';
import { webSearchTool as legacyWebSearchTool } from './builtins/webSearchTool.js';
import { createCompatibleSearchTool } from '../services/search/sharedSearchAdapter.js';
import { webScreenshotTool } from './builtins/webScreenshotTool.js';
import { mediaInfoTool } from './builtins/mediaInfoTool.js';
import { mediaApiTool } from './builtins/mediaApiTool.js';
import { searchHistoryTool } from './builtins/searchHistoryTool.js';
import { readHistoryTool } from './builtins/readHistoryTool.js';
import { pdfTool } from './builtins/pdfTool.js';
import { calculatorTool } from './builtins/calculatorTool.js';
import { clipboardTool } from './builtins/clipboardTool.js';
import { translateTool } from './builtins/translateTool.js';
import { imageTool } from './builtins/imageTool.js';
import { reminderTool } from './builtins/reminderTool.js';
import { knowledgeTool } from './builtins/knowledgeTool.js';
import { xlsxTool } from './builtins/xlsxTool.js';
import {
  browserOpenTool,
  browserSnapshotTool,
  browserCloseTool,
  browserClickTool,
  browserFillTool,
  browserWaitForTool,
} from './builtins/browserTools.js';

export { registerTool, registerTools, getTool, getAllTools, getToolsByCategory, unregisterTool, clearRegistry } from './registryCore.js';

// ─── Bootstrap built-in tools ─────────────────────────────────────────────────

let _bootstrapped = false;
const webSearchTool = createCompatibleSearchTool(legacyWebSearchTool);

/**
 * Register all built-in tools.  Safe to call multiple times (idempotent).
 */
export function bootstrapBuiltinTools() {
  if (_bootstrapped) return;
  _bootstrapped = true;
  registerTools([bashTool, fileReadTool, fileEditTool, fileWriteTool, fileDeleteTool, fileMoveTool, fileMkdirTool, globTool, grepTool, delegateTool, {...delegateTool,id:'agent',name:'Agent (legacy alias)',run:delegateTask}, fetchUrlTool, webSearchTool, webScreenshotTool, mediaInfoTool, mediaApiTool, searchHistoryTool, readHistoryTool, pdfTool, xlsxTool, calculatorTool, clipboardTool, translateTool, imageTool, reminderTool, knowledgeTool, browserOpenTool, browserSnapshotTool, browserCloseTool, browserClickTool, browserFillTool, browserWaitForTool]);
}
