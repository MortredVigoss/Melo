/**
 * image tool
 *
 * Image processing: OCR, metadata/EXIF, resize, convert format, generate.
 * Uses sharp (resize/convert/info), tesseract.js (OCR), MiniMax (generate).
 *
 * Output routing
 * --------------
 * When `output` is omitted for `process`/`generate`, the result is written to
 * `${workspacePath}/generated/img-<timestamp>-<rand>.<ext>` and the tool
 * returns a short-lived signed URL via `signWorkspaceFileUrl`. The UI's URL
 * detector (src/media/urlDetector.js → IMAGE_EXT) then auto-promotes the URL
 * to a kind='image' attachment so the rendered image appears inline with the
 * assistant's reply.
 *
 * If the caller supplies an explicit `output` path, legacy behaviour is
 * preserved: write to that path, return the path as text.
 */

import { mkdir, readFile, stat } from 'node:fs/promises';
import { gatedReadIntoBuffer } from '../../safety/gatedRead.js';
import { resolve, extname, basename, join, isAbsolute } from 'node:path';
import { randomBytes } from 'node:crypto';
import { signWorkspaceFileUrl } from '../../web/urlSigning.js';

const MAX_IMAGE_BYTES = 20 * 1024 * 1024; // 20MB

// ─── OCR via tesseract.js ─────────────────────────────────────────────────────

async function ocrImage(filePathOrBuffer) {
  const { createWorker } = await import('tesseract.js');
  const worker = await createWorker(['eng', 'chi_sim', 'chi_tra', 'jpn', 'kor'], 1, {
    logger: () => {},
  });
  try {
    const { data } = await worker.recognize(filePathOrBuffer);
    return {
      text: (data.text || '').trim(),
      confidence: data.confidence || 0,
      lines: data.lines?.length || 0,
    };
  } finally {
    await worker.terminate();
  }
}

// ─── Metadata via sharp ──────────────────────────────────────────────────────

async function getImageMeta(filePathOrBuffer) {
  const sharp = (await import('sharp')).default;
  const meta = await sharp(filePathOrBuffer).metadata();
  // Phase 2C: when given a Buffer, size is buffer.length; when given
  // a path, fall back to stat for the on-disk size.
  const size = Buffer.isBuffer(filePathOrBuffer)
    ? filePathOrBuffer.length
    : (await stat(filePathOrBuffer)).size;
  return {
    width: meta.width,
    height: meta.height,
    format: meta.format,
    space: meta.space,
    channels: meta.channels,
    depth: meta.depth,
    density: meta.density,
    hasAlpha: meta.hasAlpha,
    orientation: meta.orientation,
    exif: meta.exif ? '(present)' : '(none)',
    size,
  };
}

// ─── Resize / Convert ────────────────────────────────────────────────────────

async function processImage(inputPathOrBuffer, outputPath, options = {}) {
  const sharp = (await import('sharp')).default;
  let pipeline = sharp(inputPathOrBuffer);

  if (options.width || options.height) {
    pipeline = pipeline.resize({
      width: options.width || undefined,
      height: options.height || undefined,
      fit: options.fit || 'inside',
      withoutEnlargement: true,
    });
  }

  if (options.rotate) pipeline = pipeline.rotate(options.rotate);
  if (options.flip) pipeline = pipeline.flip();
  if (options.flop) pipeline = pipeline.flop();
  if (options.grayscale) pipeline = pipeline.grayscale();
  if (options.quality) {
    const ext = extname(outputPath).toLowerCase();
    if (ext === '.jpg' || ext === '.jpeg') pipeline = pipeline.jpeg({ quality: options.quality });
    else if (ext === '.png') pipeline = pipeline.png({ quality: options.quality });
    else if (ext === '.webp') pipeline = pipeline.webp({ quality: options.quality });
  }

  const info = await pipeline.toFile(outputPath);
  return {
    path: outputPath,
    width: info.width,
    height: info.height,
    format: info.format,
    size: info.size,
  };
}

// ─── Workspace output helpers ────────────────────────────────────────────────

function workspaceGeneratedDir(workspacePath) {
  if (!workspacePath || typeof workspacePath !== 'string') return null;
  return join(workspacePath, 'generated');
}

async function allocateWorkspaceOutputPath(workspacePath, extWithDot) {
  const dir = workspaceGeneratedDir(workspacePath);
  if (!dir) return null;
  await mkdir(dir, { recursive: true });
  const ts = Date.now().toString(36);
  const rand = randomBytes(4).toString('hex');
  const ext = (extWithDot || '.png').toLowerCase();
  return join(dir, `img-${ts}-${rand}${ext}`);
}

function resolveOutputPath(outputArg, workspacePath) {
  if (!outputArg) return null;
  if (isAbsolute(outputArg)) return outputArg;
  if (workspacePath) return resolve(workspacePath, outputArg);
  return resolve(outputArg);
}

/**
 * Decide the engine try-order for `generate`.
 *
 * - 'sdcpp'        → try sd.cpp only
 * - 'minimax'      → try MiniMax only
 * - 'codex-oauth'  → try Codex OAuth image tool only
 * - 'auto' (default) → honour config.imageEngine; otherwise
 *     codex-oauth → sdcpp → minimax. Codex is first because:
 *        • zero marginal cost for Plus subscribers (counted against Codex
 *          usage bucket, not a separate API bill);
 *        • quality/speed beats local sd.cpp on most Apple-Silicon laptops;
 *        • gracefully falls through with NOT_CONFIGURED when the user isn't
 *          signed into Codex, so sdcpp (fully offline) stays the safe
 *          fallback for anyone without an OAuth session.
 */
function resolveEngineOrder(engineArg, { config } = {}) {
  if (engineArg === 'sdcpp') return ['sdcpp'];
  if (engineArg === 'minimax') return ['minimax'];
  if (engineArg === 'codex-oauth' || engineArg === 'codex') return ['codex-oauth'];
  const preferred = String(config?.imageEngine || '').trim().toLowerCase();
  if (preferred === 'minimax') return ['minimax', 'codex-oauth', 'sdcpp'];
  if (preferred === 'sdcpp') return ['sdcpp', 'codex-oauth', 'minimax'];
  if (preferred === 'codex-oauth' || preferred === 'codex') {
    return ['codex-oauth', 'sdcpp', 'minimax'];
  }
  // Default: try the free cloud path (Codex Plus subscription) first, fall
  // back to local sd.cpp (fully offline), then paid cloud as the last resort.
  return ['codex-oauth', 'sdcpp', 'minimax'];
}

// ─── Tool definition ─────────────────────────────────────────────────────────

export const imageTool = {
  id: 'image',
  name: 'Image',
  description:
    'Image tool. ' +
    'ocr: extract text (zh/en/ja/ko). ' +
    'info: dimensions + format + EXIF. ' +
    'process: resize / rotate / grayscale / format convert (omit "output" to auto-save into chat workspace and return a displayable URL). ' +
    'generate: text-to-image. Default engine is local sd.cpp + SDXL (fully offline, 15-25s per image on Apple Silicon Metal) when the model file is present; falls back to MiniMax if `engine: "minimax"` is passed or no local model is installed. Returns a URL the UI renders inline.',
  category: 'filesystem',
  isConcurrencySafe: true,
  // No permission prompt: all four actions are non-destructive —
  //   • ocr / info      → read-only on the input file
  //   • process         → writes into the chat workspace (generated/… by
  //                       default, explicit `output` path is explicit user intent)
  //   • generate        → writes a new PNG into workspace/generated/
  // Requiring a permission dialog before "画张图" is a UX regression: the
  // permission prompt has a 120s timeout (permissions.js) and if the user
  // doesn't notice / click, the request fails with a misleading "timeout"
  // error — the actual image engine never even starts. Same risk class as
  // fetchUrl / webSearch / mediaInfo, which are also permission-free.
  requiresPermission: false,
  // Generate-by-diffusion takes real wall clock time:
  //   • sd.cpp on Apple Silicon: ~15–25s for SDXL @ 30 steps
  //   • MiniMax:                  ~5–20s HTTP + ~2s download
  //   • Codex OAuth (gpt-image-2): usually 30–60s, sometimes 90–120s
  // The engine layer also enforces its own 120s cap; 180s here is a safety
  // margin around the slower Codex path so the outer tool executor doesn't
  // preempt a healthy in-progress stream.
  timeout: 180_000,
  parametersSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['ocr', 'info', 'process', 'generate'],
        description: 'ocr | info | process | generate',
      },
      path: {
        type: 'string',
        description: 'Input image file path. Required for ocr/info/process.',
      },
      output: {
        type: 'string',
        description:
          'For process/generate: optional output path. Omit to auto-save into the chat workspace and return a displayable URL. ' +
          'Extension determines format (.jpg / .png / .webp).',
      },
      width:   { type: 'number',  description: 'process/generate: target width in px. Default 1024 for generate.' },
      height:  { type: 'number',  description: 'process/generate: target height in px. Default 1024 for generate.' },
      quality: { type: 'number',  description: 'process: output quality 1-100 (jpg/png/webp).' },
      rotate:  { type: 'number',  description: 'process: rotation angle in degrees.' },
      grayscale: { type: 'boolean', description: 'process: convert to grayscale.' },
      prompt:  { type: 'string',  description: 'generate: text description of the image.' },
      negativePrompt: {
        type: 'string',
        description: 'generate (sdcpp only): things the image should avoid.',
      },
      engine: {
        type: 'string',
        enum: ['auto', 'sdcpp', 'minimax', 'codex-oauth'],
        description:
          'generate: which backend to use. "auto" (default) tries Codex OAuth ' +
          '(image_generation tool via /codex/responses; free for ChatGPT Plus ' +
          'subscribers) first, then local sd.cpp, then MiniMax. ' +
          '"codex-oauth" forces the OAuth path; "sdcpp" forces local; "minimax" ' +
          'forces paid cloud. NOTE: when the user is on Codex OAuth, image ' +
          'generation is also wired straight into the regular chat stream ' +
          '(see createCodexResponsesReply) — the model can simply ask for an ' +
          'image and Codex will inline it; this `image` tool stays available ' +
          'for explicit-engine selection (forcing sdcpp / minimax) and for ' +
          'OCR / process / info actions which do not exist on the chat path.',
      },
      steps: {
        type: 'number',
        description: 'generate (sdcpp only): sampling steps. Default 30, range 1-60.',
      },
      cfgScale: {
        type: 'number',
        description: 'generate (sdcpp only): classifier-free-guidance scale. Default 7.5, range 1-15.',
      },
      seed: {
        type: 'number',
        description: 'generate (sdcpp only): RNG seed for reproducible output. Omit for random.',
      },
      model: {
        type: 'string',
        description: 'generate (sdcpp only): absolute path to a .safetensors checkpoint. Overrides the configured default.',
      },
      aspectRatio: {
        type: 'string',
        enum: ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3'],
        description: 'generate (minimax only): output aspect ratio. Default "1:1". Ignored by sdcpp — use width/height instead.',
      },
    },
    required: ['action'],
  },
  examples: [
    { action: 'ocr', path: '/path/to/screenshot.png' },
    { action: 'info', path: '/path/to/photo.jpg' },
    { action: 'process', path: '/path/to/in.png', operation: 'resize', width: 800 },
    { action: 'generate', prompt: 'a cat sitting on a windowsill at sunset', width: 1024, height: 1024 },
  ],

  async run(args, context = {}) {
    const { action, path: inputPath, output } = args || {};
    const { workspacePath, config, signal, sseEmitter, chatId } = context;

    if (!action) {
      return { ok: false, output: 'Missing required: action.', error: 'INVALID_PARAMS' };
    }

    // ── generate (no input file required) ─────────────────────────────────
    if (action === 'generate') {
      const prompt = String(args?.prompt || '').trim();
      if (!prompt) {
        return { ok: false, output: 'Missing "prompt" for generate.', error: 'INVALID_PARAMS' };
      }

      const engineArg = String(args?.engine || 'auto').toLowerCase();
      const engines = resolveEngineOrder(engineArg, { config });

      // Resolve output path — explicit > workspace auto > error.
      // sd.cpp always writes PNG; MiniMax returns JPG.  Output extension is
      // decided per-engine below so the caller gets a sane default.
      //
      // `triedErrors` captures per-engine failures so the aggregate
      // "nothing worked" branch at the bottom can synthesize a useful
      // error. Each entry carries { engine, notConfigured, message } —
      // the `notConfigured` flag lets us promote the aggregate to
      // NOT_CONFIGURED when every engine bailed on "missing credentials"
      // (vs actually trying to generate and failing).
      const triedErrors = [];

      for (const engine of engines) {
        // Default container per engine:
        //   sdcpp / codex-oauth → PNG (both emit PNG natively)
        //   minimax             → JPG (the MiniMax API returns JPEG)
        const ext = engine === 'minimax' ? '.jpg' : '.png';
        let outPath = resolveOutputPath(output, workspacePath);
        if (!outPath) outPath = await allocateWorkspaceOutputPath(workspacePath, ext);
        if (!outPath) {
          return {
            ok: false,
            output: 'No workspace available and no "output" path provided.',
            error: 'NO_OUTPUT_PATH',
          };
        }
        try {
          const { dirname } = await import('node:path');
          await mkdir(dirname(outPath), { recursive: true });
        } catch { /* non-fatal */ }

        try {
          if (engine === 'sdcpp') {
            const { generateWithSdcpp, defaultMeloHomeDir } = await import('../../images/sdcppEngine.js');
            const homeDir = config?.meloHomeDir || defaultMeloHomeDir(context?.projectRoot);
            const result = await generateWithSdcpp({
              prompt,
              negativePrompt: args?.negativePrompt,
              outputPath: outPath,
              config,
              homeDir,
              model: args?.model,
              steps: args?.steps,
              cfgScale: args?.cfgScale,
              seed: args?.seed,
              width: args?.width,
              height: args?.height,
              signal,
            });
            const url = signWorkspaceFileUrl(result.path);
            return {
              ok: true,
              output:
                `Generated image: ${url}\n` +
                `(saved to ${result.path}, ${(result.bytes / 1024).toFixed(1)} KB, ${result.mimeType}, engine=sdcpp)`,
              meta: {
                path: result.path,
                url,
                bytes: result.bytes,
                mimeType: result.mimeType,
                prompt,
                engine: 'sdcpp',
                model: result.model,
              },
            };
          }

          if (engine === 'codex-oauth') {
            // Codex OAuth image tool. We pass the same `signal` through; the
            // engine layer also enforces its own 120s timeout. The engine
            // throws with err.code === 'NOT_CONFIGURED' when the user isn't
            // signed into Codex, so we route that to a fallthrough rather
            // than a hard error (matches the minimax branch below).
            try {
              const { generateAndSaveImageViaCodex } = await import('../../images/codexImageEngine.js');
              const result = await generateAndSaveImageViaCodex({
                prompt,
                outputPath: outPath,
                signal,
              });
              const url = signWorkspaceFileUrl(result.path);
              return {
                ok: true,
                output:
                  `Generated image: ${url}\n` +
                  `(saved to ${result.path}, ${(result.bytes / 1024).toFixed(1)} KB, ${result.mimeType}, engine=codex-oauth, model=${result.model})`,
                meta: {
                  path: result.path,
                  url,
                  bytes: result.bytes,
                  mimeType: result.mimeType,
                  prompt,
                  engine: 'codex-oauth',
                  model: result.model,
                },
              };
            } catch (e) {
              // NOT_CONFIGURED → treat like minimax-without-apiKey so `auto`
              // falls through to the next engine. GENERATE_FAILED bubbles
              // up through the surrounding try/catch as a regular error.
              if (e?.code === 'NOT_CONFIGURED') {
                triedErrors.push({
                  engine: 'codex-oauth',
                  notConfigured: true,
                  message: e.message,
                });
                continue;
              }
              throw e;
            }
          }

          // engine === 'minimax'
          const apiKey = String(config?.minimaxApiKey || process.env.MINIMAX_API_KEY || '').trim();
          if (!apiKey) {
            triedErrors.push({
              engine: 'minimax',
              notConfigured: true,
              message: 'missing minimaxApiKey (pass via config or MINIMAX_API_KEY env)',
            });
            continue;
          }
          const groupId = String(config?.minimaxGroupId || process.env.MINIMAX_GROUP_ID || '').trim() || undefined;
          const aspectRatio = args?.aspectRatio || '1:1';
          const { generateAndSaveImage } = await import('../../images/imageGen.js');
          const result = await generateAndSaveImage({
            prompt,
            aspectRatio,
            apiKey,
            groupId,
            outputPath: outPath,
            signal,
          });
          const url = signWorkspaceFileUrl(result.path);
          return {
            ok: true,
            output:
              `Generated image: ${url}\n` +
              `(saved to ${result.path}, ${(result.bytes / 1024).toFixed(1)} KB, ${result.mimeType}, engine=minimax)`,
            meta: {
              path: result.path,
              url,
              bytes: result.bytes,
              mimeType: result.mimeType,
              prompt,
              aspectRatio,
              engine: 'minimax',
            },
          };
        } catch (e) {
          // Treat NOT_CONFIGURED (Codex) and NOT_INSTALLED (sd.cpp: missing
          // binary/model) as the same class of "engine not set up on this
          // machine" failure — both are things the user fixes by
          // installing/authenticating, not by debugging a runtime error.
          const isSetupFailure = e?.code === 'NOT_CONFIGURED' || e?.code === 'NOT_INSTALLED';
          triedErrors.push({
            engine,
            notConfigured: isSetupFailure,
            message: e.message,
          });
          // If the user forced a specific engine, don't fall through.
          if (engineArg === engine) {
            return {
              ok: false,
              output: `Image generation failed (${engine}): ${e.message}`,
              error: e.code || 'GENERATE_FAILED',
            };
          }
          // auto-fallback to the next engine
          continue;
        }
      }

      // Every engine bailed.  Aggregate reporting:
      //   • if 100% of attempts were NOT_CONFIGURED, surface NOT_CONFIGURED
      //     so the UI can prompt the user to connect a credential (vs
      //     a generic "it failed" that hides the real fix);
      //   • otherwise fall back to GENERATE_FAILED.
      const allMisconfig =
        triedErrors.length > 0 && triedErrors.every(item => item.notConfigured);
      const summary = triedErrors
        .map(item => `${item.engine}: ${item.message}`)
        .join(' | ');
      if (allMisconfig) {
        // Hint which engines the user can enable — keep the list of engine
        // names compact so the UI can pattern-match for "MiniMax" / "Codex"
        // / "sd.cpp" without string gymnastics.
        const engineList = triedErrors.map(item => item.engine).join(', ');
        return {
          ok: false,
          output:
            `Image generation has no configured engine available. ` +
            `Connect one of: ${engineList}. Details: ${summary}. ` +
            `MiniMax needs minimaxApiKey; Codex OAuth needs an active login; ` +
            `sd.cpp needs a local model file.`,
          error: 'NOT_CONFIGURED',
        };
      }

      return {
        ok: false,
        output: `Image generation failed on all engines. Tried: ${summary}`,
        error: 'GENERATE_FAILED',
      };
    }

    // ── ocr / info / process — all need a valid input path ─────────────────
    // Phase 2C (2026-05-04): only gate-read for KNOWN actions that
    // actually consume the file. Otherwise an unknown action would
    // trigger a UI prompt for nothing — and the original "INVALID_
    // ACTION" branch below would never be reached.
    const READING_ACTIONS = new Set(['ocr', 'info', 'process']);
    if (!READING_ACTIONS.has(action)) {
      return { ok: false, output: `Unknown action "${action}".`, error: 'INVALID_ACTION' };
    }
    if (!inputPath) {
      return { ok: false, output: 'Missing required: path.', error: 'INVALID_PARAMS' };
    }
    const absPath = resolve(inputPath);

    // Gate the input image read once. atomicOpenLeaf+S_ISREG+size
    // cap all happen inside gatedReadIntoBuffer; the Buffer is what
    // sharp / tesseract consume — no library re-opens the path, so
    // the post-approval TOCTOU window is closed.
    const gated = await gatedReadIntoBuffer(absPath, { workspacePath, sseEmitter, signal, chatId }, {
      maxBytes: MAX_IMAGE_BYTES,
      toolName: `image:${action}`,
    });
    if (!gated.ok) {
      return { ok: false, output: gated.output, error: gated.error, meta: gated.meta };
    }
    const inputBuffer = gated.buffer;

    if (action === 'ocr') {
      try {
        const result = await ocrImage(inputBuffer);
        if (!result.text) return { ok: true, output: '(No text detected in image)', meta: result };
        return {
          ok: true,
          output: `**OCR Result** (confidence: ${result.confidence.toFixed(1)}%, ${result.lines} lines):\n\n${result.text}`,
          meta: result,
        };
      } catch (e) {
        return { ok: false, output: `OCR failed: ${e.message}`, error: 'OCR_FAILED' };
      }
    }

    if (action === 'info') {
      try {
        const meta = await getImageMeta(inputBuffer);
        const lines = [
          `**File:** ${basename(absPath)}`,
          `**Dimensions:** ${meta.width} × ${meta.height}`,
          `**Format:** ${meta.format}`,
          `**Color space:** ${meta.space} (${meta.channels}ch${meta.hasAlpha ? ', alpha' : ''})`,
          `**Size:** ${(meta.size / 1024).toFixed(1)} KB`,
          meta.density ? `**DPI:** ${meta.density}` : '',
          `**EXIF:** ${meta.exif}`,
        ].filter(Boolean);
        return { ok: true, output: lines.join('\n'), meta };
      } catch (e) {
        return { ok: false, output: `Metadata failed: ${e.message}`, error: 'META_FAILED' };
      }
    }

    if (action === 'process') {
      const { width, height, quality, rotate, grayscale } = args;

      // Pick output path — explicit wins; otherwise auto into workspace using
      // the input's extension. Returns null if neither is usable.
      let outPath = resolveOutputPath(output, workspacePath);
      if (!outPath) {
        const ext = extname(absPath) || '.png';
        outPath = await allocateWorkspaceOutputPath(workspacePath, ext);
      }
      if (!outPath) {
        return {
          ok: false,
          output: 'No workspace available and no "output" path provided.',
          error: 'NO_OUTPUT_PATH',
        };
      }
      try {
        const { dirname } = await import('node:path');
        await mkdir(dirname(outPath), { recursive: true });
      } catch { /* non-fatal */ }

      try {
        const result = await processImage(inputBuffer, outPath, { width, height, quality, rotate, grayscale });
        // Only mint a signed URL when the output lives under the workspace —
        // for explicit external paths the user asked for a file, not a URL.
        let url = null;
        if (workspacePath && result.path.startsWith(workspacePath)) {
          try { url = signWorkspaceFileUrl(result.path); } catch { /* best-effort */ }
        }
        const label = url
          ? `Image: ${url}\n(saved to ${result.path}, ${result.width}×${result.height}, ${result.format}, ${(result.size / 1024).toFixed(1)} KB)`
          : `Image saved: ${result.path} (${result.width}×${result.height}, ${result.format}, ${(result.size / 1024).toFixed(1)} KB)`;
        return {
          ok: true,
          output: label,
          meta: { ...result, url },
        };
      } catch (e) {
        return { ok: false, output: `Process failed: ${e.message}`, error: 'PROCESS_FAILED' };
      }
    }

    return { ok: false, output: `Unknown action "${action}".`, error: 'INVALID_ACTION' };
  },
};
