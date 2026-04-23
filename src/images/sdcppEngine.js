/**
 * Local image generation via sd.cpp (Apple Silicon Metal backend).
 *
 * sd.cpp is a portable C++ port of Stable Diffusion that runs fully offline.
 * On Apple Silicon we build it with Metal, which gives SDXL inference at
 * roughly 15-25s per 1024×1024 image on an M-series chip.
 *
 * Why this sits next to MiniMax imageGen.js
 * -----------------------------------------
 * MiniMax is cloud-only, costs per call, and is subject to content policy
 * on the provider side.  sd.cpp is fully local — no network call, no
 * credentials, no policy filter.  Keeping both engines behind the same
 * `image` tool lets the user pick by availability (sd.cpp requires a
 * model file on disk; MiniMax requires API key).
 *
 * Binary lookup order
 * -------------------
 *   1) `config.sdcppBinary` (absolute path)
 *   2) `SDCPP_BINARY` env var
 *   3) `.tmp/melo-home-user/sd-bin/{sd,sd-cli}`  (our per-user install location)
 *   4) Common system locations (`/usr/local/bin`, `/opt/homebrew/bin`) with
 *      either `sd` or `sd-cli` — recent stable-diffusion.cpp builds renamed
 *      the CLI binary from `sd` to `sd-cli`, so we try both.
 *
 * Model lookup order
 * ------------------
 *   1) `model` arg (absolute path)
 *   2) `config.sdcppModelPath`
 *   3) `.tmp/melo-home-user/sd-models/sd_xl_base_1.0.safetensors`  (default)
 *
 * This file intentionally owns NO UI concerns.  The caller (imageTool.js)
 * resolves workspace paths, mints signed URLs, and formats the reply text.
 */

import { spawn } from 'node:child_process';
import { access, stat } from 'node:fs/promises';
import { resolve, join, isAbsolute } from 'node:path';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';

// Try both the old (`sd`) and new (`sd-cli`) binary names.  Recent releases
// of stable-diffusion.cpp renamed the CLI target from `sd` → `sd-cli` (with
// `sd-server` as a sibling).  Older local installs still have `sd`.
const DEFAULT_BIN_CANDIDATES = [
  '/usr/local/bin/sd',
  '/usr/local/bin/sd-cli',
  '/opt/homebrew/bin/sd',
  '/opt/homebrew/bin/sd-cli',
];

const DEFAULT_MODEL_RELATIVE = 'sd-models/sd_xl_base_1.0.safetensors';
// Look for either name in the per-user install location — same rationale.
const DEFAULT_INSTALL_CANDIDATES = [
  'sd-bin/sd',
  'sd-bin/sd-cli',
];

// Conservative upper bounds so a malformed prompt can't run for an hour.
const MAX_STEPS = 60;
const MAX_WIDTH = 2048;
const MAX_HEIGHT = 2048;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

// ─── Locator helpers ────────────────────────────────────────────────────────

/**
 * Resolve the sd.cpp binary.  Returns an absolute path or throws
 * NOT_INSTALLED with a human-readable install hint.
 */
export async function resolveSdcppBinary({ config, homeDir } = {}) {
  // 1. Explicit config wins.
  const fromConfig = String(config?.sdcppBinary || '').trim();
  if (fromConfig) {
    if (await pathExists(fromConfig)) return fromConfig;
    throw Object.assign(new Error(`sdcppBinary configured but not found: ${fromConfig}`), {
      code: 'NOT_INSTALLED',
    });
  }

  // 2. Env var.
  const fromEnv = (process.env.SDCPP_BINARY || '').trim();
  if (fromEnv && (await pathExists(fromEnv))) return fromEnv;

  // 3. Our per-user install — try both `sd` and `sd-cli`.
  if (homeDir) {
    for (const rel of DEFAULT_INSTALL_CANDIDATES) {
      const local = join(homeDir, rel);
      if (await pathExists(local)) return local;
    }
  }

  // 4. Common system locations.
  for (const p of DEFAULT_BIN_CANDIDATES) {
    if (await pathExists(p)) return p;
  }

  throw Object.assign(
    new Error(
      'sd.cpp binary not found. Install stable-diffusion.cpp with Metal support ' +
        '(see docs/sd-setup.md) or set `sdcppBinary` in Melo config.',
    ),
    { code: 'NOT_INSTALLED' },
  );
}

/**
 * Resolve the SDXL model file.  Returns an absolute path or throws
 * NOT_INSTALLED.
 */
export async function resolveSdcppModel({ config, homeDir, model } = {}) {
  if (model) {
    const abs = isAbsolute(model) ? model : resolve(model);
    if (await pathExists(abs)) return abs;
    throw Object.assign(new Error(`SD model not found: ${abs}`), { code: 'NOT_INSTALLED' });
  }

  const fromConfig = String(config?.sdcppModelPath || '').trim();
  if (fromConfig) {
    if (await pathExists(fromConfig)) return fromConfig;
    throw Object.assign(new Error(`sdcppModelPath configured but not found: ${fromConfig}`), {
      code: 'NOT_INSTALLED',
    });
  }

  if (homeDir) {
    const defaultPath = join(homeDir, DEFAULT_MODEL_RELATIVE);
    if (await pathExists(defaultPath)) return defaultPath;
  }

  throw Object.assign(
    new Error(
      'SDXL base 1.0 model not found. Place sd_xl_base_1.0.safetensors in ' +
        `${DEFAULT_MODEL_RELATIVE} or set sdcppModelPath in Melo config.`,
    ),
    { code: 'NOT_INSTALLED' },
  );
}

async function pathExists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

// ─── Argument construction ───────────────────────────────────────────────────

/**
 * Clamp user input + build the argv for sd.cpp.
 *
 * Exported for unit tests — pure, no FS.
 */
export function buildSdcppArgs({
  binary,
  model,
  prompt,
  negativePrompt,
  output,
  steps,
  cfgScale,
  seed,
  width,
  height,
  sampler,
  scheduler,
  metal = true,
}) {
  if (!binary) throw new Error('binary required');
  if (!model) throw new Error('model required');
  if (!prompt) throw new Error('prompt required');
  if (!output) throw new Error('output required');

  const args = [
    '--model', model,
    '--prompt', prompt,
    '--output', output,
    '--steps', String(clamp(steps, 1, MAX_STEPS, 30)),
    '--cfg-scale', String(clamp(cfgScale, 1, 15, 7.5)),
    '--width', String(clamp(width, 256, MAX_WIDTH, 1024)),
    '--height', String(clamp(height, 256, MAX_HEIGHT, 1024)),
  ];

  if (negativePrompt) args.push('--negative-prompt', String(negativePrompt));
  if (Number.isFinite(seed)) args.push('--seed', String(seed));
  if (sampler) args.push('--sampling-method', String(sampler));
  if (scheduler) args.push('--schedule', String(scheduler));

  // sd.cpp on Apple Silicon picks Metal automatically when built with METAL=1,
  // but some builds require an explicit flag.  `--rng cuda` is a no-op on
  // Metal builds so we don't force it.
  if (metal) args.push('-v'); // enable progress output

  return args;
}

function clamp(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

// ─── Runner ─────────────────────────────────────────────────────────────────

/**
 * Run sd.cpp and wait for the output PNG to appear.
 *
 * @param {Object} opts
 * @param {string} opts.binary - absolute path to sd.cpp binary
 * @param {string} opts.model - absolute path to .safetensors
 * @param {string} opts.prompt
 * @param {string} [opts.negativePrompt]
 * @param {string} opts.output - absolute path where PNG will be written
 * @param {number} [opts.steps=30]
 * @param {number} [opts.cfgScale=7.5]
 * @param {number} [opts.seed]
 * @param {number} [opts.width=1024]
 * @param {number} [opts.height=1024]
 * @param {string} [opts.sampler]
 * @param {string} [opts.scheduler]
 * @param {AbortSignal} [opts.signal]
 * @param {number} [opts.timeoutMs]
 * @param {(line: string) => void} [opts.onStderr]
 * @returns {Promise<{ path: string, bytes: number, stderr: string }>}
 */
export function runSdcpp(opts) {
  const { binary, signal, timeoutMs = DEFAULT_TIMEOUT_MS, onStderr } = opts;
  const args = buildSdcppArgs(opts);

  return new Promise((resolve, reject) => {
    let settled = false;
    let stderrChunks = '';

    const child = spawn(binary, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGKILL'); } catch { /* noop */ }
      reject(Object.assign(new Error(`sd.cpp timed out after ${timeoutMs}ms`), { code: 'TIMEOUT' }));
    }, timeoutMs);

    const onAbort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill('SIGTERM'); } catch { /* noop */ }
      reject(Object.assign(new Error('aborted'), { code: 'ABORTED' }));
    };
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
    }

    child.stderr?.on('data', (buf) => {
      const s = buf.toString('utf8');
      stderrChunks += s;
      if (onStderr) {
        for (const line of s.split(/\r?\n/)) {
          if (line.trim()) onStderr(line);
        }
      }
    });
    // sd.cpp also prints progress to stdout depending on the build
    child.stdout?.on('data', (buf) => {
      const s = buf.toString('utf8');
      stderrChunks += s;
      if (onStderr) {
        for (const line of s.split(/\r?\n/)) {
          if (line.trim()) onStderr(line);
        }
      }
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(Object.assign(err, { code: err.code || 'SPAWN_FAILED' }));
    });

    child.on('close', async (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (code !== 0) {
        reject(Object.assign(
          new Error(`sd.cpp exited with code ${code}:\n${tail(stderrChunks, 40)}`),
          { code: 'EXIT_NONZERO', exitCode: code, stderr: stderrChunks },
        ));
        return;
      }
      try {
        const st = await stat(opts.output);
        resolve({ path: opts.output, bytes: st.size, stderr: stderrChunks });
      } catch (e) {
        reject(Object.assign(
          new Error(`sd.cpp reported success but output missing: ${opts.output}`),
          { code: 'OUTPUT_MISSING', cause: e, stderr: stderrChunks },
        ));
      }
    });
  });
}

function tail(str, maxLines) {
  const lines = String(str || '').split(/\r?\n/);
  if (lines.length <= maxLines) return str;
  return '…\n' + lines.slice(-maxLines).join('\n');
}

// ─── Top-level convenience — mirrors imageGen.generateAndSaveImage ───────────

/**
 * Generate an image with sd.cpp and save it to `outputPath`.
 *
 * Higher-level wrapper used by imageTool.  Resolves binary + model,
 * invokes sd.cpp, and returns a MiniMax-compatible result shape so the
 * tool layer can be engine-agnostic.
 */
export async function generateWithSdcpp({
  prompt,
  negativePrompt,
  outputPath,
  config,
  homeDir,
  model,
  steps,
  cfgScale,
  seed,
  width,
  height,
  sampler,
  scheduler,
  signal,
  onProgress,
}) {
  const binary = await resolveSdcppBinary({ config, homeDir });
  const modelPath = await resolveSdcppModel({ config, homeDir, model });

  const result = await runSdcpp({
    binary,
    model: modelPath,
    prompt,
    negativePrompt,
    output: outputPath,
    steps,
    cfgScale,
    seed,
    width,
    height,
    sampler,
    scheduler,
    signal,
    onStderr: onProgress,
  });

  return {
    path: result.path,
    bytes: result.bytes,
    mimeType: 'image/png',
    engine: 'sdcpp',
    binary,
    model: modelPath,
  };
}

// ─── Resolve the Melo home dir (same convention as state.json) ───────────────

/**
 * Return .tmp/melo-home-user — the same directory the rest of Melo uses
 * for per-user state.  Callers may pass `homeDir` directly; this is a
 * convenience fallback.
 */
export function defaultMeloHomeDir(projectRoot) {
  const envHome = process.env.MELO_HOME;
  if (envHome && existsSync(envHome)) return envHome;
  if (projectRoot) {
    const candidate = join(projectRoot, '.tmp', 'melo-home-user');
    if (existsSync(candidate)) return candidate;
  }
  // Last resort: ~/.melo
  return join(homedir(), '.melo');
}
