// adapters/host-entry.ts
import { join as join10 } from "node:path";

// upstream/src/host/index.ts
import { createReadStream, existsSync as existsSync5, fstatSync, readFileSync as readFileSync2 } from "node:fs";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join as join5, normalize, resolve as resolve2, sep } from "node:path";
import { fileURLToPath as fileURLToPath2 } from "node:url";

// upstream/src/host/helper-process.ts
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { downloadArtifact } from "@electron/get";
var require2 = createRequire(import.meta.url);
var here = dirname(fileURLToPath(import.meta.url));
var packageRoot = resolve(here, "..");
var defaultHelperMain = resolve(packageRoot, "runtime", "electron-helper", "main.js");
var BRIDGE_PREFIX = "dsh-pet-bridge:";
function resolveElectronPath(candidates = []) {
  const seen = /* @__PURE__ */ new Set();
  const list = [];
  const push = (value) => {
    if (!value || seen.has(value)) return;
    seen.add(value);
    list.push(value);
  };
  for (const value of candidates) push(value);
  if (process.env.DSH_PET_ELECTRON_PATH) push(process.env.DSH_PET_ELECTRON_PATH);
  try {
    const resolved = require2("electron");
    if (typeof resolved === "string" && resolved) push(resolved);
  } catch {
  }
  push(defaultElectronExe());
  return list.find((value) => existsSync(value));
}
function hasGraphicalDisplay() {
  if (process.platform !== "linux") return true;
  if (process.env.DSH_PET_DESKTOP_FORCE === "1") return true;
  return Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}
function dshHomeDir() {
  const userProfile = process.env.USERPROFILE || process.env.HOME || "";
  return process.env.DSH_HOME || join(userProfile, ".dsh");
}
var PLAT = process.platform;
var ELECTRON_REL = PLAT === "win32" ? "electron.exe" : PLAT === "darwin" ? join("Electron.app", "Contents", "MacOS", "Electron") : "electron";
function electronLandingDir() {
  return join(dshHomeDir(), "electron");
}
function defaultElectronExe() {
  return join(electronLandingDir(), ELECTRON_REL);
}
async function ensureElectronDownload(options = {}) {
  const version = options.version || process.env.DSH_PET_ELECTRON_VERSION || "43.3.0";
  const mirror = options.mirror || process.env.DSH_PET_ELECTRON_MIRROR || "https://npmmirror.com/mirrors/electron/";
  const timeoutMs = options.timeoutMs ?? 10 * 60 * 1e3;
  const targetDir = electronLandingDir();
  const exe = defaultElectronExe();
  if (existsSync(exe)) return exe;
  const log = (message) => console.log(`[dsh-pet] ${message}`);
  const warn = (message) => console.warn(`[dsh-pet] ${message}`);
  const startedAt = Date.now();
  log(`Electron not found, downloading v${version} (${PLAT}-${process.arch}) ...`);
  try {
    mkdirSync(targetDir, { recursive: true });
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error(`Electron download timed out after ${timeoutMs}ms`)),
      timeoutMs
    );
    timer.unref?.();
    let nextLogAt = Date.now() + 3e3;
    try {
      const zipPath = await downloadArtifact({
        version: `v${version}`,
        artifactName: "electron",
        // platform/arch 不传：@electron/get 用宿主平台与架构自动推断
        // （getHostArch 还处理 arm → armv7l 特例，比显式传 process.arch 更准）
        mirrorOptions: { mirror: mirror.replace(/\/$/, "") + "/" },
        downloadOptions: {
          signal: controller.signal,
          quiet: true,
          // 关掉 @electron/get 自己的进度条（stdout 走宿主日志，不进 bridge 协议）
          getProgressCallback: async (progress) => {
            const now = Date.now();
            if (!progress.total || now < nextLogAt) return;
            nextLogAt = now + 3e3;
            log(
              `downloading ${(progress.transferred / 1024 / 1024).toFixed(1)}MB / ${(progress.total / 1024 / 1024).toFixed(1)}MB`
            );
          }
        }
      });
      const seconds = ((Date.now() - startedAt) / 1e3).toFixed(1);
      log(`download complete (${seconds}s), extracting to ${targetDir} ...`);
      const { default: extract } = await import("@electron-internal/extract-zip");
      await extract(zipPath, { dir: targetDir });
      if (!existsSync(exe)) {
        throw new Error(`Electron zip extracted, but ${ELECTRON_REL} not found`);
      }
      const readySeconds = ((Date.now() - startedAt) / 1e3).toFixed(1);
      log(`ready in ${readySeconds}s: ${exe}`);
      return exe;
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    warn(`ensure failed: ${error instanceof Error ? error.message : String(error)}`);
    warn("desktop pet unavailable. Set DSH_PET_ELECTRON_PATH to an existing Electron, or retry later.");
    return void 0;
  }
}
function defaultLaunch(options = {}) {
  const electronPath = resolveElectronPath([options.electronPath]);
  if (!electronPath) {
    throw new Error("dsh-pet: cannot resolve Electron executable. Set DSH_PET_ELECTRON_PATH or install electron.");
  }
  const helperPath = options.helperPath || defaultHelperMain;
  return { command: electronPath, args: [helperPath] };
}
var HELPER_STOP_TIMEOUT_MS = 3e3;
var HELPER_STOP_GRACE_MS = 1e3;
function helperSpawnEnv(hostPid, extra) {
  const env = { ...process.env, DSH_PET_HOST_PID: String(hostPid), ...extra };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}
var HelperProcess = class {
  constructor(options = {}, logger2 = console) {
    this.options = options;
    this.logger = logger2;
    this.child = void 0;
    this.stopping = false;
    this.restartTimer = void 0;
    this.restartFailures = 0;
    this.lastStartAt = 0;
    this.stdoutBuffer = "";
  }
  start() {
    if (this.child || this.stopping) return this.child;
    this.lastStartAt = Date.now();
    const helperPath = this.options.helperPath || defaultHelperMain;
    const launch = this.options.command ? { command: this.options.command, args: this.options.args || [helperPath] } : defaultLaunch(this.options);
    const command = launch.command;
    const args = this.options.args || launch.args;
    const cwd = this.options.cwd || dshHomeDir();
    mkdirSync(cwd, { recursive: true });
    const child = spawn(command, args, {
      cwd,
      // DSH_PET_HOST_PID：把**宿主自己的** pid 交给 helper，让它能判断"宿主还在不在"
      // （helper 侧 host-liveness.js 每 2s kill(pid, 0) 一次；ESRCH 就自行退出，见 issue #56）。
      // 放在唯一的 spawn 点，所有调用方（含自定义 command）自动获得。
      // 为什么 macOS/Linux 非有不可：Windows 上 Node/libuv 会把子进程放进带
      // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE 的 job 对象，宿主一退出内核就顺手杀掉它——实测
      // helper 的心跳正好停在宿主退出的那一刻、连 process.on('exit') 都不触发；POSIX 没有这层
      // 兜底，宿主非正常退出后 helper 会一直留着（issue #56 报告的就是这个）。
      // 环境变量统一经 helperSpawnEnv 构造：它会删掉会劫持 Electron 启动模式的 ELECTRON_RUN_AS_NODE
      // （issue #63，详见该函数注释）。
      env: helperSpawnEnv(process.pid, this.options.env),
      stdio: ["pipe", "pipe", "pipe"],
      // stdin 也要：bridge 协议响应回写（main.js 请求经 stdout 上来）
      windowsHide: true
    });
    this.child = child;
    child.once("error", (error) => {
      this.logger.error?.(`dsh-pet desktop helper failed to start: ${error.message}`);
      if (child.pid === void 0 && this.child === child) {
        this.child = void 0;
        this.scheduleRestart();
      }
    });
    child.once("exit", (code, signal) => {
      if (this.child !== child) return;
      this.child = void 0;
      if (!this.stopping) {
        this.logger.warn?.(
          `dsh-pet desktop helper exited (code=${String(code)}, signal=${String(signal)}); restarting`
        );
        this.scheduleRestart();
      }
    });
    child.stdout.on("data", (chunk) => {
      this.onStdoutChunk(String(chunk));
    });
    child.stderr.on("data", (chunk) => {
      const line = String(chunk).trim();
      if (line) this.logger.warn?.(`[dsh-pet desktop helper] ${line}`);
    });
    child.stdin?.on("error", () => {
    });
    return child;
  }
  /** stdout 按行缓冲：`dsh-pet-bridge:` 前缀整行 = 协议请求，其余 = 日志行 */
  onStdoutChunk(chunk) {
    this.stdoutBuffer += chunk;
    let nl;
    while ((nl = this.stdoutBuffer.indexOf("\n")) >= 0) {
      const line = this.stdoutBuffer.slice(0, nl);
      this.stdoutBuffer = this.stdoutBuffer.slice(nl + 1);
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (trimmed.startsWith(BRIDGE_PREFIX)) {
        void this.handleBridgeLine(trimmed);
        continue;
      }
      this.logger.debug?.(`[dsh-pet desktop helper] ${trimmed}`);
    }
  }
  /** 处理一条协议请求：交给宿主 bridgeHandler，结果按 id POST 回 main.js 的回调服务器
   *  （cb 由请求行携带；不走 stdin —— Electron 主进程收不到 piped stdin） */
  async handleBridgeLine(line) {
    const child = this.child;
    if (!child?.stdin || !this.options.bridgeHandler) return;
    let req;
    try {
      req = JSON.parse(line.slice(BRIDGE_PREFIX.length));
    } catch {
      this.logger.warn?.("[dsh-pet desktop helper] bridge \u534F\u8BAE\u884C\u975E\u6CD5\uFF0C\u5DF2\u5FFD\u7565");
      return;
    }
    if (typeof req.id !== "number") return;
    try {
      const resp = await this.options.bridgeHandler(req);
      this.sendBridgeResponse(req, resp);
    } catch (e) {
      this.sendBridgeResponse(req, {
        id: req.id,
        status: 500,
        contentType: "application/json; charset=utf-8",
        body: JSON.stringify({ error: `bridge handler error: ${e instanceof Error ? e.message : String(e)}` })
      });
    }
  }
  /** 把应答发回 main.js：优先 POST 到请求行携带的 cb（本地回调服务器）；无 cb 时回写 stdin（低版本兼容） */
  sendBridgeResponse(req, resp) {
    const cb = typeof req.cb === "string" && /^https?:[/][/]/.test(req.cb) ? req.cb : "";
    if (cb) {
      void fetch(cb, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(resp)
      }).catch(() => {
      });
      return;
    }
    const child = this.child;
    if (!child?.stdin || child.stdin.destroyed) return;
    try {
      child.stdin.write(BRIDGE_PREFIX + JSON.stringify(resp) + "\n");
    } catch {
    }
  }
  /** 停止 helper：发 SIGTERM 即返回，**不等它退出**。宿主退出/插件卸载路径用它——
   *  宿主马上就没了（Windows 有 job 对象、POSIX 有 helper 自己的 host-liveness 兜底，见 issue #56）。
   *  **停止后要立刻重启的场景必须用 stopAndWait()**，否则新旧进程会短暂重叠（issue #64）。 */
  stop(reason = "plugin-disposed") {
    this.stopping = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = void 0;
    this.logger.debug?.(`dsh-pet desktop helper stopping (${reason})`);
    const child = this.child;
    if (!child) return;
    child.kill();
  }
  /**
   * 停止 helper 并**等它真正退出**（issue #64）：原实现只发一次 SIGTERM 就返回、紧接着 spawn 新进程，
   * 而 Electron 收到 SIGTERM 后关窗、销毁 GPU/动画合成器是异步的（几百 ms 起）——旧窗口（旧大小）
   * 还没消失、新窗口（新大小）已经画出来，桌面上就短暂出现"两只宠物"。
   *   ① 先置 `stopping`（由 stop() 完成）：守护逻辑不得把这次主动停止误判成崩溃去自动重启；
   *   ② 只等 `exit`，**不等 `close`**：stdio 管道关闭远早于进程真正退出（实测 SIGTERM 后 ~10ms 就触发）；
   *   ③ 超时（默认 3s）升级 SIGKILL；SIGKILL 后再给 1s 宽限，仍未退出就放弃等待——
   *      配置保存绝不能因为一个退不掉的子进程而被无限挂住。
   */
  async stopAndWait(reason = "plugin-disposed", timeoutMs = HELPER_STOP_TIMEOUT_MS) {
    this.stop(reason);
    const child = this.child;
    if (!child) return;
    await waitForChildExit(child, timeoutMs, () => {
      this.logger.warn?.(`dsh-pet desktop helper \u672A\u5728 ${timeoutMs}ms \u5185\u9000\u51FA\uFF0C\u5347\u7EA7 SIGKILL\uFF08${reason}\uFF09`);
      try {
        child.kill("SIGKILL");
      } catch {
      }
    });
  }
  scheduleRestart() {
    if (this.restartTimer || this.stopping) return;
    if (helperRunIsStable(Date.now() - this.lastStartAt)) {
      this.restartFailures = 0;
    } else {
      this.restartFailures += 1;
    }
    if (shouldCircuitBreak(this.restartFailures, this.resolveMaxFailures())) {
      this.logger.error?.(
        `dsh-pet desktop helper crashed ${this.restartFailures} consecutive times; circuit breaker tripped, no more restarts. Fix the environment (e.g. DISPLAY/headless) or set DSH_PET_RESTART_MAX_FAILURES to raise the limit.`
      );
      return;
    }
    const base = this.resolveRestartBaseMs();
    const delay = restartBackoffDelayMs(this.restartFailures - 1, base);
    this.logger.warn?.(
      `dsh-pet desktop helper exited; restarting in ${Math.round(delay)}ms (attempt ${this.restartFailures}, consecutive-crash limit ${this.resolveMaxFailures()})`
    );
    this.restartTimer = setTimeout(() => {
      this.restartTimer = void 0;
      this.start();
    }, delay);
    this.restartTimer.unref?.();
  }
  /** 退避基值：DSH_PET_RESTART_BASE_MS（ms，>0）可调，默认 750。 */
  resolveRestartBaseMs() {
    return envPositiveInt(process.env.DSH_PET_RESTART_BASE_MS, RESTART_BASE_MS_DEFAULT);
  }
  /** 熔断阈值：DSH_PET_RESTART_MAX_FAILURES（次，>0）可调，默认 12。 */
  resolveMaxFailures() {
    return envPositiveInt(process.env.DSH_PET_RESTART_MAX_FAILURES, RESTART_MAX_FAILURES_DEFAULT);
  }
};
function waitForChildExit(child, timeoutMs, onTimeout) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve3) => {
    let giveUpTimer;
    const done = () => {
      clearTimeout(killTimer);
      if (giveUpTimer) clearTimeout(giveUpTimer);
      child.removeListener("exit", done);
      resolve3();
    };
    const killTimer = setTimeout(() => {
      onTimeout();
      giveUpTimer = setTimeout(done, HELPER_STOP_GRACE_MS);
      giveUpTimer.unref?.();
    }, timeoutMs);
    killTimer.unref?.();
    child.once("exit", done);
  });
}
var HELPER_STABLE_MS = 3 * 60 * 1e3;
function restartBackoffDelayMs(consecutiveFailures, baseMs = 750) {
  const MAX = 3e4;
  const raw = baseMs * 2 ** Math.max(0, consecutiveFailures);
  return Math.min(raw, MAX);
}
function shouldCircuitBreak(consecutiveFailures, limit = 12) {
  return consecutiveFailures >= limit;
}
function helperRunIsStable(elapsedMs) {
  return elapsedMs >= HELPER_STABLE_MS;
}
var RESTART_BASE_MS_DEFAULT = 750;
var RESTART_MAX_FAILURES_DEFAULT = 12;
function envPositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

// upstream/src/standalone/shims/dsh-credentials.ts
function credentialRef(ref) {
  return ref;
}

// upstream/src/host/balance/internal.ts
var FETCH_TIMEOUT_MS = 2e4;
var RETRIES = 3;
async function fetchOnce(url, key) {
  return fetch(url, {
    headers: { Authorization: "Bearer " + key, "User-Agent": "dsh-pet-balance" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
  });
}
async function fetchWithRetry(url, key) {
  let last;
  for (let i = 0; i <= RETRIES; i++) {
    try {
      return await fetchOnce(url, key);
    } catch (e) {
      last = e;
      if (i < RETRIES) await new Promise((r) => setTimeout(r, 800));
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}
function num(value, what) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error("dsh-pet: \u4F59\u989D\u6570\u636E\u975E\u6CD5\u5B57\u6BB5 " + what);
  return n;
}
function str(value, what) {
  if (typeof value !== "string" || value.length === 0) throw new Error("dsh-pet: \u4F59\u989D\u6570\u636E\u975E\u6CD5\u5B57\u6BB5 " + what);
  return value;
}
function looseNum(value) {
  if (value === void 0 || value === null || value === "") return void 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : void 0;
}
function obj(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : void 0;
}
function resetTime(value) {
  if (typeof value === "string") return value.length > 0 ? value : void 0;
  const n = looseNum(value);
  if (n === void 0 || n <= 0) return void 0;
  const ms = n < 1e12 ? n * 1e3 : n;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? void 0 : d.toISOString();
}
function readWindow(value) {
  const w = obj(value);
  if (!w) return void 0;
  const used = looseNum(w.used);
  const cap = looseNum(w.cap);
  if (used === void 0 || cap === void 0 || cap <= 0) return void 0;
  return { percent: Math.max(0, used / cap * 100), capUsd: cap, resetsAt: resetTime(w.resetAt) };
}
function queryString(params) {
  const pairs = Object.entries(params).filter(([, v]) => v !== void 0);
  return pairs.length > 0 ? "?" + pairs.map(([k, v]) => k + "=" + encodeURIComponent(v)).join("&") : "";
}
function money(value, what) {
  const raw = str(value, what);
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error("dsh-pet: \u8D26\u53F7\u4F59\u989D\u91D1\u989D\u975E\u6CD5 " + what);
  return n.toFixed(2);
}
function sumMoney(a, b) {
  return ((Math.round(Number(a) * 100) + Math.round(Number(b) * 100)) / 100).toFixed(2);
}

// upstream/src/host/balance/providers/commandcode.ts
var API_BASE = "https://api.commandcode.ai";
var ROLLING_LABEL = "5h";
async function fetchJson(url, key, label) {
  const res = await fetchWithRetry(url, key);
  if (!res.ok) throw new Error("commandcode " + label + " HTTP " + res.status);
  return await res.json();
}
function parseCommandCode(creditsBody, subscriptionBody, summaryBody, provider) {
  const root = obj(creditsBody);
  const credits = obj(root?.credits);
  if (!credits) throw new Error("dsh-pet: commandcode \u54CD\u5E94\u7F3A\u5C11 credits");
  const creditFields = [credits.monthlyCredits, credits.purchasedCredits, credits.freeCredits];
  if (creditFields.every((v) => looseNum(v) === void 0)) {
    throw new Error("dsh-pet: commandcode credits \u54CD\u5E94\u7F3A\u5C11\u989D\u5EA6\u5B57\u6BB5");
  }
  const remaining = creditFields.reduce((sum, v) => sum + Math.max(0, looseNum(v) ?? 0), 0);
  const summary = obj(summaryBody);
  const spentRaw = summary?.totalCost;
  if (spentRaw === void 0 || spentRaw === null) throw new Error("dsh-pet: commandcode usage \u54CD\u5E94\u7F3A\u5C11 totalCost");
  const spent = Math.max(0, num(spentRaw, "totalCost"));
  const pool = spent + remaining;
  const data = { monthly: pool > 0 ? spent / pool * 100 : 0 };
  if (pool > 0) data.monthlyCapUsd = pool;
  const subscription = obj(obj(subscriptionBody)?.data);
  const periodEnd = subscription?.currentPeriodEnd;
  if (typeof periodEnd === "string" && periodEnd.length > 0) data.monthlyResetsAt = periodEnd;
  const limits = obj(root?.windowLimits) ?? obj(credits.windowLimits);
  if (limits?.limited === true) {
    const fiveHour = readWindow(limits.fiveHour);
    if (fiveHour) {
      data.rolling = fiveHour.percent;
      data.rollingCapUsd = fiveHour.capUsd;
      data.rollingLabel = ROLLING_LABEL;
      if (fiveHour.resetsAt) data.rollingResetsAt = fiveHour.resetsAt;
    }
    const weekly = readWindow(limits.weekly);
    if (weekly) {
      data.weekly = weekly.percent;
      data.weeklyCapUsd = weekly.capUsd;
      if (weekly.resetsAt) data.weeklyResetsAt = weekly.resetsAt;
    }
  }
  return { ok: true, provider, shape: "windows", data };
}
var commandCode = {
  ids: ["commandcode"],
  credential: { mode: "ref", ref: "COMMANDCODE_API_KEY" },
  async fetch({ key, provider }) {
    const whoami = obj(
      await fetchJson(API_BASE + "/alpha/whoami" + queryString({ limits: "1" }), key, "/alpha/whoami")
    );
    const org = obj(whoami?.org);
    const orgId = typeof org?.id === "string" && org.id.length > 0 ? org.id : void 0;
    const credits = await fetchJson(
      API_BASE + "/alpha/billing/credits" + queryString({ orgId }),
      key,
      "/alpha/billing/credits"
    );
    let subscription;
    try {
      subscription = await fetchJson(
        API_BASE + "/alpha/billing/subscriptions" + queryString({ orgId }),
        key,
        "/alpha/billing/subscriptions"
      );
    } catch {
      subscription = void 0;
    }
    const periodStart = obj(obj(subscription)?.data)?.currentPeriodStart;
    const summary = await fetchJson(
      API_BASE + "/alpha/usage/summary" + queryString({ since: typeof periodStart === "string" ? periodStart : void 0, orgId }),
      key,
      "/alpha/usage/summary"
    );
    return parseCommandCode(credits, subscription, summary, provider);
  }
};

// upstream/src/host/balance/deepseek-common.ts
var DEEPSEEK_FULL_BALANCE = { CNY: "20", USD: "5" };
function deepseekFullBalance(currency) {
  return DEEPSEEK_FULL_BALANCE[currency];
}
function deepseekPricingTier(now = /* @__PURE__ */ new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    weekday: "short",
    hour: "2-digit",
    hourCycle: "h23"
    // h23 避免午夜被格式化为 "24:00"
  }).formatToParts(now);
  const pick = (type) => parts.find((p) => p.type === type)?.value;
  const weekday = pick("weekday");
  const hour = Number(pick("hour"));
  if (weekday === "Sat" || weekday === "Sun") return "idle";
  return hour >= 9 && hour < 12 || hour >= 14 && hour < 18 ? "peak" : "idle";
}

// upstream/src/host/balance/providers/deepseek-account.ts
function parseAccountBalance(snapshot, provider) {
  if (!snapshot) throw new Error("dsh-pet: \u8D26\u53F7\u672A\u767B\u5F55\uFF08deepseek-account\uFF09");
  if (snapshot.status !== "ready") throw new Error("dsh-pet: \u8D26\u53F7\u4F59\u989D\u67E5\u8BE2\u5931\u8D25");
  const wallets = Array.isArray(snapshot.value) ? snapshot.value : [];
  if (wallets.length === 0) throw new Error("dsh-pet: \u8D26\u53F7\u6CA1\u6709\u5145\u503C\u94B1\u5305\u4F59\u989D");
  const candidates = wallets.map((w) => obj(w)).filter((w) => w !== void 0);
  if (candidates.length === 0) throw new Error("dsh-pet: \u8D26\u53F7\u94B1\u5305\u7ED3\u6784\u975E\u6CD5");
  const toppedUpBy = /* @__PURE__ */ new Map();
  for (const w of candidates) {
    const currency = typeof w.currency === "string" && w.currency.length > 0 ? w.currency : "CNY";
    const amount = money(w.balance, "balance");
    const prev = toppedUpBy.get(currency);
    toppedUpBy.set(currency, prev === void 0 ? amount : sumMoney(prev, amount));
  }
  const grantedBy = /* @__PURE__ */ new Map();
  for (const raw of Array.isArray(snapshot.bonusWallets) ? snapshot.bonusWallets : []) {
    const w = obj(raw);
    if (!w || typeof w.currency !== "string" || w.currency.length === 0) continue;
    const amount = money(w.balance, "bonus balance");
    const prev = grantedBy.get(w.currency);
    grantedBy.set(w.currency, prev === void 0 ? amount : sumMoney(prev, amount));
  }
  for (const currency of grantedBy.keys()) {
    if (!toppedUpBy.has(currency)) toppedUpBy.set(currency, "0.00");
  }
  const walletsOut = [...toppedUpBy.entries()].map(([currency, toppedUp]) => {
    const granted = grantedBy.get(currency) ?? "0.00";
    const fullBalance = deepseekFullBalance(currency);
    return {
      currency,
      // 与官方路由**同构**：官方文档定义 total_balance = 赠送 + 充值，这里由两个钱包加出来
      total: sumMoney(granted, toppedUp),
      granted,
      toppedUp,
      ...fullBalance === void 0 ? {} : { fullBalance }
    };
  });
  return {
    ok: true,
    provider,
    shape: "money",
    data: { wallets: walletsOut, tier: deepseekPricingTier() }
  };
}
var deepseekAccount = {
  ids: ["deepseek-account"],
  credential: { mode: "none" },
  async fetch({ provider, resolveAccount }) {
    if (!resolveAccount) throw new Error("dsh-pet: \u7F3A\u5C11\u8D26\u53F7\u670D\u52A1\uFF08" + provider + "\uFF09");
    return parseAccountBalance(await resolveAccount(), provider);
  }
};

// upstream/src/host/balance/providers/deepseek-official.ts
var deepseekOfficial = {
  ids: ["deepseek-official"],
  credential: { mode: "ref", ref: "DEEPSEEK_API_KEY" },
  async fetch({ key, provider }) {
    const res = await fetchWithRetry("https://api.deepseek.com/user/balance", key);
    if (!res.ok) throw new Error("deepseek balance HTTP " + res.status);
    const body = await res.json();
    const infos = body?.balance_infos;
    if (!Array.isArray(infos) || infos.length === 0)
      throw new Error("dsh-pet: deepseek balance \u54CD\u5E94\u7F3A\u5C11 balance_infos");
    const wallets = infos.map((raw) => {
      const w = obj(raw) ?? {};
      const currency = str(w.currency, "currency");
      const fullBalance = deepseekFullBalance(currency);
      return {
        currency,
        total: str(w.total_balance, "total_balance"),
        granted: str(w.granted_balance, "granted_balance"),
        toppedUp: str(w.topped_up_balance, "topped_up_balance"),
        ...fullBalance === void 0 ? {} : { fullBalance }
      };
    });
    return {
      ok: true,
      provider,
      shape: "money",
      data: { wallets, tier: deepseekPricingTier() }
    };
  }
};

// upstream/src/host/balance/providers/opencode-go.ts
var QUOTA_USD = {
  rolling: 12,
  weekly: 30,
  monthly: 60
};
var ROLLING_LABEL2 = "5h";
var opencodeGo = {
  ids: ["opencode-go"],
  credential: { mode: "ref", ref: "OPENCODE_GO_API_KEY" },
  async fetch({ key, provider }) {
    const res = await fetchWithRetry("https://opencode.ai/zen/go/v1/usage", key);
    if (!res.ok) throw new Error("opencode usage HTTP " + res.status);
    const body = await res.json();
    const usage = body?.usage;
    if (!usage || typeof usage !== "object") throw new Error("dsh-pet: opencode usage \u54CD\u5E94\u7F3A\u5C11 usage");
    const u = usage;
    const rolling = u.rolling, weekly = u.weekly, monthly = u.monthly;
    if (!rolling || !weekly || !monthly) throw new Error("dsh-pet: opencode usage \u54CD\u5E94\u7F3A\u5C11\u7A97\u53E3");
    return {
      ok: true,
      provider,
      shape: "windows",
      data: {
        rolling: num(rolling.percent, "rolling.percent"),
        weekly: num(weekly.percent, "weekly.percent"),
        monthly: num(monthly.percent, "monthly.percent"),
        rollingCapUsd: QUOTA_USD.rolling,
        weeklyCapUsd: QUOTA_USD.weekly,
        monthlyCapUsd: QUOTA_USD.monthly,
        rollingLabel: ROLLING_LABEL2,
        rollingResetsAt: str(rolling.resetsAt, "rolling.resetsAt"),
        weeklyResetsAt: str(weekly.resetsAt, "weekly.resetsAt"),
        monthlyResetsAt: str(monthly.resetsAt, "monthly.resetsAt")
      }
    };
  }
};

// upstream/src/host/balance/index.ts
var BALANCE_PROVIDERS = [opencodeGo, commandCode, deepseekOfficial, deepseekAccount];
function matchBalanceProvider(provider) {
  return BALANCE_PROVIDERS.find((p) => p.ids.includes(provider));
}
function failed(provider, reason, message) {
  return message === void 0 ? { ok: false, provider, reason } : { ok: false, provider, reason, message };
}
async function queryBalance(provider, resolveKey, resolveAccount) {
  const def = matchBalanceProvider(provider);
  if (!def) return failed(provider, "unsupported");
  let key = "";
  if (def.credential.mode === "ref") {
    const resolved = await resolveKey(def.credential.ref);
    if (!resolved) return failed(provider, "credential-missing", "\u7F3A\u5C11\u51ED\u8BC1 " + def.credential.ref);
    key = resolved;
  } else if (!resolveAccount) {
    return failed(provider, "credential-missing", "\u7F3A\u5C11\u8D26\u53F7\u670D\u52A1\uFF08" + provider + "\uFF09");
  }
  try {
    return await def.fetch({ provider, key, resolveAccount });
  } catch (e) {
    return failed(provider, "fetch-error", e instanceof Error ? e.message : String(e));
  }
}

// upstream/src/standalone/shims/dsh-llm.ts
function createUserMessage(input) {
  return { role: "user", content: input.content, source: input.source };
}
function createAssistantMessage(input) {
  return { role: "assistant", content: input.content, source: input.source };
}
var BlockAssembler = class {
  constructor() {
    this.chunks = [];
  }
  /** 收集一个块；非文本块（工具调用等）在独立模式下被忽略 */
  push(chunk) {
    if (chunk !== null && typeof chunk === "object" && chunk.type === "text") {
      const text = chunk.text;
      if (typeof text === "string") this.chunks.push(text);
    }
  }
  /** 当前已拼装的块列表 */
  blocks() {
    const text = this.chunks.join("");
    return text === "" ? [] : [{ type: "text", text }];
  }
};
function ReasoningEffortId(id) {
  return id;
}

// upstream/src/host/llm-call.ts
var PET_CALL_IDENTITY = "dsh-pet";
function noTextReason(finish) {
  const { kind, failure } = finish ?? {};
  if (kind === "aborted") return "\u751F\u6210\u5DF2\u53D6\u6D88";
  if (kind === "max-tokens") return "\u8F93\u51FA\u8FBE\u5230\u4E0A\u9650\uFF0C\u672A\u4EA7\u51FA\u6B63\u6587";
  if (kind !== "error") return "\u6A21\u578B\u672A\u8FD4\u56DE\u6587\u672C";
  const { message, code } = failure ?? {};
  if (typeof message === "string" && message.trim() !== "") return message;
  if (typeof code === "string" && code.trim() !== "") return code;
  return "\u672A\u63D0\u4F9B\u5931\u8D25\u539F\u56E0";
}

// upstream/src/host/llm-reasoning.ts
async function supportsReasoningOff(ctx, provider, model) {
  const llm = ctx.llm;
  if (!llm || typeof llm.resolveModelInfo !== "function") return false;
  try {
    const info = await llm.resolveModelInfo(provider, model);
    return info?.reasoning?.efforts?.some((e) => e.id === "off") ?? false;
  } catch {
    return false;
  }
}

// upstream/src/host/model-selection.ts
function configuredModel(conf, key) {
  const raw = conf?.[key];
  if (!raw || typeof raw !== "object") return void 0;
  const m = raw;
  if (typeof m.provider !== "string" || typeof m.model !== "string") return void 0;
  const provider = m.provider.trim();
  const model = m.model.trim();
  return provider && model ? { provider, model } : void 0;
}
function currentModel(ctx) {
  try {
    const sel = ctx.agentDefaultModel?.currentSelection();
    return sel?.provider && sel?.model ? { provider: sel.provider, model: sel.model } : void 0;
  } catch {
    return void 0;
  }
}
function modelCandidates(ctx, preferred) {
  const out = [];
  const push = (m) => {
    if (!m) return;
    if (out.some((x) => x.provider === m.provider && x.model === m.model)) return;
    out.push(m);
  };
  push(preferred);
  push(currentModel(ctx));
  return out;
}
function modelLabel(m) {
  return m.provider + "/" + m.model;
}

// upstream/src/host/whisper.ts
var TIMEOUT_MS = 3e4;
var USER_TEXT = "\u968F\u4FBF\u8BF4\u4E00\u53E5\u65E5\u5E38\u788E\u788E\u5FF5\uFF0C\u4E00\u53E5\u5C31\u597D\uFF0C20 \u5B57\u4EE5\u5185\u3002";
function userTextWithMeme(meme) {
  return "\u968F\u4FBF\u8BF4\u4E00\u53E5\u65E5\u5E38\u788E\u788E\u5FF5\uFF0C\u4E00\u53E5\u5C31\u597D\uFF0C20 \u5B57\u4EE5\u5185\u3002\n\u8FD9\u6B21\u4F1A\u914D\u4E00\u5F20\u8868\u60C5\u5305\u4E00\u8D77\u663E\u793A\uFF0C\u56FE\u7684\u5185\u5BB9\u662F\uFF1A" + meme.name + "\uFF08" + meme.desc + "\uFF09\u3002\n\u8BF7\u8BA9\u8FD9\u53E5\u8BDD\u548C\u8FD9\u5F20\u56FE\u7684\u60C5\u7EEA/\u573A\u666F\u81EA\u7136\u5951\u5408\uFF0C\u50CF\u662F\u914D\u5408\u753B\u9762\u8BF4\u51FA\u6765\u7684\uFF1B\u4E0D\u8981\u63CF\u8FF0\u753B\u9762\u672C\u8EAB\u3002";
}
async function generateWhisper(ctx, system, meme, preferred) {
  const candidates = modelCandidates(ctx, preferred);
  if (candidates.length === 0) {
    return { ok: false, reason: "provider-missing", message: "\u5F53\u524D\u5BF9\u8BDD\u672A\u914D\u7F6E\u6A21\u578B" };
  }
  const llm = ctx.llm;
  if (!llm || typeof llm.stream !== "function") {
    return { ok: false, reason: "generate-error", message: "LLM \u670D\u52A1\u4E0D\u53EF\u7528" };
  }
  let last = { ok: false, reason: "generate-error", message: noTextReason(void 0) };
  for (const [i, sel] of candidates.entries()) {
    const result = await generateWith(ctx, llm, sel, system, meme);
    if (result.ok) return result;
    last = result;
    if (i + 1 < candidates.length) {
      console.warn(
        `dsh-pet: \u788E\u788E\u5FF5\u7528 ${modelLabel(sel)} \u751F\u6210\u5931\u8D25\uFF08${result.message ?? result.reason}\uFF09\uFF0C\u56DE\u843D\u5230 ${modelLabel(candidates[i + 1])}`
      );
    }
  }
  return last;
}
async function generateWith(ctx, llm, sel, system, meme) {
  const deadline = AbortSignal.timeout(TIMEOUT_MS);
  const supportsOff = await supportsReasoningOff(ctx, sel.provider, sel.model);
  const options = {
    provider: sel.provider,
    model: sel.model,
    // 调用身份（见 llm-call.ts）：缺它时 opencode-go 回 400
    sessionId: PET_CALL_IDENTITY,
    messages: [
      createUserMessage({
        content: [{ type: "text", text: meme ? userTextWithMeme(meme) : USER_TEXT }],
        source: { kind: "user" }
      })
    ],
    system,
    // 不显式限 maxTokens：推理模型会把思考计入预算，显式小上限只会截断正文报"模型未返回文本"；
    // 不传由 dsh-llm 按适配器 defaultMaxTokens（默认 32768）兜底，碎碎念短指令输出仍短。
    temperature: 1,
    // 统一关闭深度思考：碎碎念不需要推理，只求随口一句（仅模型声明支持时传）
    ...supportsOff ? { reasoningEffort: ReasoningEffortId("off") } : {},
    signal: deadline
  };
  const assembler = new BlockAssembler();
  try {
    for await (const chunk of llm.stream(options)) {
      assembler.push(chunk);
    }
  } catch (e) {
    return {
      ok: false,
      reason: "generate-error",
      message: e instanceof Error ? e.message : String(e)
    };
  }
  const text = assembler.blocks().filter((b) => b.type === "text").map((b) => "text" in b ? b.text : "").join("").trim();
  if (!text) return { ok: false, reason: "generate-error", message: noTextReason(assembler.finish) };
  return meme ? { ok: true, text, image: meme.name } : { ok: true, text };
}

// upstream/src/host/whisper-policy.ts
function automaticWhisperSchedule(policy, petEnabled, configuredPeriodSec) {
  if (!policy) return { enabled: petEnabled, periodSec: configuredPeriodSec };
  const period = policy.whisperIntervalSec();
  return {
    enabled: petEnabled && policy.isReady() && policy.canWhisper(),
    periodSec: Number.isFinite(period) ? Math.max(60, period) : 300
  };
}

// upstream/src/host/memes.ts
import { existsSync as existsSync2 } from "node:fs";
import { join as join2 } from "node:path";
function readMemePool(memes, dirs) {
  if (!memes || typeof memes !== "object" || Array.isArray(memes)) return [];
  if (dirs.length === 0) return [];
  const out = [];
  for (const [name, desc] of Object.entries(memes)) {
    const text = typeof desc === "string" ? desc.trim() : "";
    if (!name || !text) continue;
    if (!dirs.some((dir) => existsSync2(join2(dir, name + ".png")))) continue;
    out.push({ name, desc: text });
  }
  return out;
}
function pickMeme(pool, random = Math.random) {
  if (pool.length === 0) return void 0;
  const idx = Math.floor(random() * pool.length) % pool.length;
  return pool[idx];
}
function matchMeme(pool, name) {
  const key = String(name ?? "").trim();
  return key ? pool.find((m) => m.name === key) : void 0;
}
var IMG_TAG = /\[图[:：]\s*([^\]\n]+?)\s*\]\s*$/;
function extractChatImage(text, pool) {
  const m = IMG_TAG.exec(text);
  if (!m) return { text };
  const hit = matchMeme(pool, m[1] ?? "");
  const body = text.slice(0, m.index).trim();
  if (!hit || !body) return { text };
  return { text: body, image: hit.name };
}
function memeCatalog(pool) {
  return pool.map((m) => "- " + m.name + "\uFF1A" + m.desc).join("\n");
}
function limitPool(pool, limit) {
  const n = Math.floor(Number(limit));
  if (!Number.isFinite(n) || n <= 0) return pool;
  return pool.slice(0, n);
}

// upstream/src/host/chat.ts
var TIMEOUT_MS2 = 6e4;
function imageInstruction(pool) {
  return "\n\n[\u914D\u56FE] \u56DE\u590D\u7ED3\u5C3E\u53EF\u9009\u9644\u4E00\u5F20\u8868\u60C5\u5305\u7ED9\u7528\u6237\u770B\uFF0C\u4ECE\u4E0B\u5217\u6E05\u5355\u91CC\u6311\u6700\u8D34\u5408\u5F53\u524D\u8BED\u5883\u7684\uFF1A\n" + memeCatalog(pool) + "\n\u6311\u4E2D\u5C31\u5728\u56DE\u590D\u6700\u540E\u53E6\u8D77\u4E00\u884C\u5199 [\u56FE:\u540D\u79F0]\uFF08\u540D\u79F0\u539F\u6837\u7167\u6284\uFF09\uFF1B\u6CA1\u6709\u5408\u9002\u7684\u5C31\u5B8C\u5168\u4E0D\u8981\u5199\u8FD9\u4E2A\u6807\u8BB0\u3002";
}
async function generateChat(ctx, system, history, userText, pool = [], preferred) {
  const melo = ctx.meloBridge;
  if (melo) {
    try {
      const reply = await melo.send(userText);
      return { ok: true, text: reply.text };
    } catch (error) {
      return { ok: false, reason: "generate-error", message: error instanceof Error ? error.message : String(error) };
    }
  }
  const candidates = modelCandidates(ctx, preferred);
  if (candidates.length === 0) {
    return { ok: false, reason: "provider-missing", message: "\u5F53\u524D\u5BF9\u8BDD\u672A\u914D\u7F6E\u6A21\u578B" };
  }
  const llm = ctx.llm;
  if (!llm || typeof llm.stream !== "function") {
    return { ok: false, reason: "generate-error", message: "LLM \u670D\u52A1\u4E0D\u53EF\u7528" };
  }
  let last = { ok: false, reason: "generate-error", message: noTextReason(void 0) };
  for (const [i, sel] of candidates.entries()) {
    const result = await generateWith2(ctx, llm, sel, system, history, userText, pool);
    if (result.ok) return result;
    last = result;
    if (i + 1 < candidates.length) {
      console.warn(
        `dsh-pet: \u5BF9\u8BDD\u7528 ${modelLabel(sel)} \u751F\u6210\u5931\u8D25\uFF08${result.message ?? result.reason}\uFF09\uFF0C\u56DE\u843D\u5230 ${modelLabel(candidates[i + 1])}`
      );
    }
  }
  return last;
}
async function generateWith2(ctx, llm, sel, system, history, userText, pool) {
  const historyMessages = history.map(
    (m) => m.role === "user" ? createUserMessage({
      content: [{ type: "text", text: m.content }],
      source: { kind: "user" }
    }) : createAssistantMessage({
      content: [{ type: "text", text: m.content }],
      source: { provider: sel.provider, model: sel.model }
    })
  );
  const deadline = AbortSignal.timeout(TIMEOUT_MS2);
  const supportsOff = await supportsReasoningOff(ctx, sel.provider, sel.model);
  const wantImage = pool.length > 0;
  const options = {
    provider: sel.provider,
    model: sel.model,
    // 调用身份（见 llm-call.ts）：缺它时 opencode-go 回 400
    sessionId: PET_CALL_IDENTITY,
    messages: [
      ...historyMessages,
      createUserMessage({
        content: [{ type: "text", text: wantImage ? userText + imageInstruction(pool) : userText }],
        source: { kind: "user" }
      })
    ],
    system,
    // 不显式限 maxTokens：与碎碎念同因——推理模型把思考计入预算，显式小上限会截断正文；
    // 不传由 dsh-llm 按适配器 defaultMaxTokens 兜底，对话短回复输出仍短。
    temperature: 1,
    // 统一关闭深度思考：闲聊对话不需要推理（与碎碎念同一约束；仅模型声明支持时传）
    ...supportsOff ? { reasoningEffort: ReasoningEffortId("off") } : {},
    signal: deadline
  };
  const assembler = new BlockAssembler();
  try {
    for await (const chunk of llm.stream(options)) {
      assembler.push(chunk);
    }
  } catch (e) {
    return {
      ok: false,
      reason: "generate-error",
      message: e instanceof Error ? e.message : String(e)
    };
  }
  const text = assembler.blocks().filter((b) => b.type === "text").map((b) => "text" in b ? b.text : "").join("").trim();
  if (!text) return { ok: false, reason: "generate-error", message: noTextReason(assembler.finish) };
  if (!wantImage) return { ok: true, text };
  const picked = extractChatImage(text, pool);
  return picked.image ? { ok: true, text: picked.text, image: picked.image } : { ok: true, text: picked.text };
}

// upstream/src/host/config.ts
import { existsSync as existsSync3, mkdirSync as mkdirSync2, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname as dirname2, join as join3 } from "node:path";
var CORNERS = ["top-left", "top-right", "bottom-left", "bottom-right"];
var CORNER_SET = new Set(CORNERS);
var PET_DISPLAYS = ["web", "desktop", "both", "none"];
var PET_DISPLAY_SET = new Set(PET_DISPLAYS);
var FONT_FAMILY_SET = /* @__PURE__ */ new Set([
  "candy",
  "yahei",
  "youyuan",
  "kaiti",
  "simsun",
  "comic",
  "system"
]);
var FONT_SIZE_MIN = 4;
var FONT_SIZE_MAX = 200;
var ID_FORBIDDEN = /[\\/:\x00-\x1f]/;
var GLOBAL_DEFAULT_KEYS = [
  "physics",
  "font",
  "confineToScreen",
  "whisperImageEnabled",
  "chatImageEnabled",
  "chatImageLimit",
  "chatMemoryRounds",
  "whisperModel",
  "chatModel",
  "eventsRefreshSec"
];
var warnedKeys = /* @__PURE__ */ new Set();
function warnOnce(key, message) {
  if (warnedKeys.has(key)) return;
  warnedKeys.add(key);
  console.warn("dsh-pet: " + message);
}
function stripJsonc(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^\\:])\/\/.*$/gm, "$1").trim();
}
function readJsonc(path) {
  try {
    const raw = JSON.parse(stripJsonc(readFileSync(path, "utf8")));
    return raw && typeof raw === "object" ? raw : void 0;
  } catch {
    return void 0;
  }
}
function readUserConfig(paths) {
  const file = effectiveUserFile(paths);
  return file ? readJsonc(file) : void 0;
}
function userConfigUnparsable(paths) {
  const file = effectiveUserFile(paths);
  return file !== void 0 && readJsonc(file) === void 0;
}
function effectiveUserFile(paths) {
  if (existsSync3(paths.userFile)) return paths.userFile;
  if (paths.legacyUserFile && existsSync3(paths.legacyUserFile)) return paths.legacyUserFile;
  return void 0;
}
function migrateUserConfig(paths, log) {
  const legacy = paths.legacyUserFile;
  if (!legacy || !existsSync3(legacy) || existsSync3(paths.userFile)) return false;
  try {
    renameSync(legacy, paths.userFile);
  } catch {
    return false;
  }
  log?.(`\u7528\u6237\u914D\u7F6E\u5DF2\u8FC1\u79FB\u5230 JSONC\uFF1A${legacy} \u2192 ${paths.userFile}`);
  return true;
}
function scanPetFiles(petDir) {
  let entries;
  try {
    entries = readdirSync(petDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter((e) => e.isFile()).map((e) => e.name).filter((name) => /^.+?-config\.(json|jsonc)$/.test(name)).sort().map((name) => ({ prefix: name.replace(/-config\.(json|jsonc)$/, ""), path: join3(petDir, name) }));
}
function readPetConfigEntry(paths, entry) {
  const hit = scanPetFiles(paths.petDir).find((f) => f.prefix === entry);
  return hit ? { path: hit.path, raw: readJsonc(hit.path) } : void 0;
}
function animationsValid(a) {
  if (!a || typeof a !== "object") return false;
  const anims = a;
  for (const key of ["idle", "turn", "drag", "clicks"]) {
    if (!Array.isArray(anims[key])) return false;
  }
  const moves = anims.moves;
  if (!moves || typeof moves !== "object" || typeof moves.default !== "object" || moves.default === null || !Array.isArray(moves.actions)) {
    return false;
  }
  if (!Array.isArray(anims.categories)) return false;
  const ev = anims.events;
  if (!ev || typeof ev !== "object" || Array.isArray(ev)) return false;
  const evEntries = ev;
  for (const pool of Object.values(evEntries)) {
    if (!Array.isArray(pool) || pool.length === 0) return false;
    for (const slot of pool) {
      if (typeof slot === "string") {
        if (slot.length === 0) return false;
      } else if (Array.isArray(slot)) {
        if (slot.length === 0) return false;
        for (const name of slot) {
          if (typeof name !== "string" || name.length === 0) return false;
        }
      } else {
        return false;
      }
    }
  }
  const balance = evEntries.balance;
  return Array.isArray(balance) && balance.length > 0;
}
function weightsValid(w) {
  if (!w || typeof w !== "object") return false;
  const weights = w;
  for (const key of ["idle", "turn", "move"]) {
    const v = Number(weights[key]);
    if (!Number.isFinite(v) || v < 0) return false;
  }
  return true;
}
function physicsValid(value) {
  if (!value || typeof value !== "object") return false;
  const p = value;
  const g = Number(p.gravity);
  const r = Number(p.restitution);
  const f = Number(p.groundFriction);
  const tp = Number(p.throwPower);
  return Number.isFinite(g) && g >= 0 && Number.isFinite(r) && r >= 0 && r <= 1 && Number.isFinite(f) && f >= 0 && typeof p.ceilingBounce === "boolean" && Number.isFinite(tp) && tp > 0 && typeof p.petCollision === "boolean";
}
function fontValid(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const f = value;
  if (typeof f.family !== "string" || !FONT_FAMILY_SET.has(f.family)) return false;
  const size = Number(f.size);
  if (!Number.isFinite(size) || size < FONT_SIZE_MIN || size > FONT_SIZE_MAX) return false;
  return typeof f.followPet === "boolean";
}
function modelSelectionValid(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const m = value;
  if (typeof m.provider !== "string" || typeof m.model !== "string") return false;
  return m.provider.trim() === "" === (m.model.trim() === "");
}
function workStatusTextsValid(value) {
  if (!Array.isArray(value) || value.length === 0) return false;
  for (const group of value) {
    if (!Array.isArray(group) || group.length === 0) return false;
    for (const text of group) {
      if (typeof text !== "string" || text.length === 0) return false;
    }
  }
  return true;
}
function topFieldValid(key, value) {
  switch (key) {
    case "whisperPrompt":
      return typeof value === "string" && value.length > 0;
    case "chatMemoryRounds": {
      const n = Number(value);
      return Number.isFinite(n) && n >= 0;
    }
    case "chatImageLimit": {
      const n = Number(value);
      return Number.isFinite(n) && n >= 0;
    }
    case "notificationsEnabled":
      return typeof value === "boolean";
    case "whisperImageEnabled":
      return typeof value === "boolean";
    case "chatImageEnabled":
      return typeof value === "boolean";
    case "confineToScreen":
      return typeof value === "boolean";
    case "animations":
      return animationsValid(value);
    case "animationWeights":
      return weightsValid(value);
    case "eventsRefreshSec":
      return eventsRefreshSecValid(value);
    case "physics":
      return physicsValid(value);
    case "font":
      return fontValid(value);
    case "whisperModel":
    case "chatModel":
      return modelSelectionValid(value);
    case "workStatusTexts":
      return workStatusTextsValid(value);
    default:
      return true;
  }
}
function eventsRefreshSecValid(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  for (const v of Object.values(value)) {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return false;
  }
  return true;
}
function packBase(base, mainOverlay) {
  if (!mainOverlay) return base;
  let out;
  for (const key of GLOBAL_DEFAULT_KEYS) {
    const own = mainOverlay[key];
    if (own === void 0 || !topFieldValid(key, own)) continue;
    out ??= { ...base };
    out[key] = own;
  }
  return out ?? base;
}
function mergeEntry(base, overlay, label, basePets, seenIds) {
  const out = {};
  for (const key of Object.keys(base)) {
    if (key === "pets") {
      out.pets = mergePets(basePets, overlay?.[key], label, seenIds);
      continue;
    }
    const own = overlay ? overlay[key] : void 0;
    if (own === void 0) {
      out[key] = base[key];
      continue;
    }
    if (!topFieldValid(key, own)) {
      warnOnce(`${label}:${key}`, `\u300C${label}\u300D\u7684 ${key} \u975E\u6CD5\uFF0C\u5DF2\u53D6\u9ED8\u8BA4\u503C`);
      out[key] = base[key];
      continue;
    }
    out[key] = own;
  }
  return out;
}
function mergePets(basePets, raw, label, seenIds) {
  const basePet = basePets[0] ?? {};
  if (!Array.isArray(raw) || raw.length === 0) {
    warnOnce(`${label}:pets`, `\u300C${label}\u300D\u7684 pets \u7F3A\u5931\u6216\u4E3A\u7A7A\uFF0C\u5DF2\u53D6\u9ED8\u8BA4\u5BA0\u7269\u5217\u8868`);
    return basePets;
  }
  const out = [];
  for (const item of raw) {
    const pet = mergePet(basePet, item, label, seenIds);
    if (pet) out.push(pet);
  }
  if (out.length === 0) {
    warnOnce(`${label}:pets`, `\u300C${label}\u300D\u7684 pets \u5168\u90E8\u88AB\u8DF3\u8FC7\uFF08id \u975E\u6CD5/\u91CD\u590D/\u51B2\u7A81\uFF09\uFF0C\u5DF2\u53D6\u9ED8\u8BA4\u5BA0\u7269\u5217\u8868`);
    return basePets;
  }
  return out;
}
function petNumber(own, def, min, label, field, id) {
  const n = Number(own);
  if (own !== void 0 && own !== null && Number.isFinite(n) && n >= min) return n;
  if (own !== void 0 && own !== null) {
    warnOnce(`${label}:${field}:${id}`, `\u5BA0\u7269\u300C${id}\u300D\u7684 ${field} \u975E\u6CD5\uFF0C\u5DF2\u53D6\u9ED8\u8BA4\u503C`);
  }
  return Number(def);
}
function petBool(own, def, label, field, id) {
  if (typeof own === "boolean") return own;
  if (own !== void 0 && own !== null) {
    warnOnce(`${label}:${field}:${id}`, `\u5BA0\u7269\u300C${id}\u300D\u7684 ${field} \u975E\u6CD5\uFF0C\u5DF2\u53D6\u9ED8\u8BA4\u503C`);
  }
  return Boolean(def);
}
function petEnum(own, set, def, label, field, id) {
  if (typeof own === "string" && set.has(own)) return own;
  if (own !== void 0 && own !== null) {
    warnOnce(`${label}:${field}:${id}`, `\u5BA0\u7269\u300C${id}\u300D\u7684 ${field} \u975E\u6CD5\uFF0C\u5DF2\u53D6\u9ED8\u8BA4\u503C`);
  }
  return typeof def === "string" ? def : "";
}
function mergePet(base, raw, label, seenIds) {
  const p = raw && typeof raw === "object" ? raw : {};
  const id = typeof p.id === "string" ? p.id.trim() : "";
  if (!id || id.length > 64 || ID_FORBIDDEN.test(id) || seenIds.has(id)) {
    warnOnce(`${label}:id:${id || "(\u7A7A)"}`, `\u300C${label}\u300D\u7684\u5BA0\u7269 id\u300C${id || "(\u7A7A)"}\u300D\u975E\u6CD5\u3001\u91CD\u590D\u6216\u5DF2\u5B58\u5728\uFF0C\u5DF2\u8DF3\u8FC7\u8BE5\u5B9E\u4F8B`);
    return null;
  }
  seenIds.add(id);
  const rawName = typeof p.name === "string" ? p.name.trim() : "";
  const name = rawName || id;
  if (!rawName) warnOnce(`${label}:name:${id}`, `\u5BA0\u7269\u300C${id}\u300D\u7F3A\u5C11 name\uFF0C\u5DF2\u6309 id \u5904\u7406`);
  const basePos = base.position && typeof base.position === "object" ? base.position : {};
  const ownPos = p.position && typeof p.position === "object" ? p.position : {};
  return {
    id,
    name,
    size: petNumber(p.size, base.size, 1, label, "size", id),
    balanceEnabled: petBool(p.balanceEnabled, base.balanceEnabled, label, "balanceEnabled", id),
    whisperEnabled: petBool(p.whisperEnabled, base.whisperEnabled, label, "whisperEnabled", id),
    workStatusEnabled: petBool(p.workStatusEnabled, base.workStatusEnabled, label, "workStatusEnabled", id),
    fixedEnabled: petBool(p.fixedEnabled, base.fixedEnabled, label, "fixedEnabled", id),
    display: petEnum(p.display, PET_DISPLAY_SET, base.display, label, "display", id),
    position: {
      corner: petEnum(ownPos.corner, CORNER_SET, basePos.corner, label, "position.corner", id),
      marginX: petNumber(ownPos.marginX, basePos.marginX, -Infinity, label, "position.marginX", id),
      marginY: petNumber(ownPos.marginY, basePos.marginY, -Infinity, label, "position.marginY", id)
    },
    // 实例级人设（可选）：只放行**非空字符串**；没写 / 空串 / 纯空白 / null → 该键不出现在结果里
    // （回落由消费端做：./persona 的 petPersona 取不到实例级就取条目顶层）；非字符串 → 告警 + 忽略。
    //
    // **这里刻意不填"生效值"**：合并器的契约是"拍平用户写了什么"，而人设的默认值是**所属条目那一份**，
    // 不是某个常量。一旦在这里把条目人设填进每只实例，/pet-display（拿合并结果 → saveUserConfig 写回）
    // 就会把"跟随条目"固化成每只实例的显式覆盖——之后用户改条目人设，这些实例不再跟着变。
    ...petPersonaField(p.whisperPrompt, label, id)
  };
}
function petPersonaField(own, label, id) {
  if (typeof own === "string") {
    return own.trim() === "" ? {} : { whisperPrompt: own };
  }
  if (own !== void 0 && own !== null) {
    warnOnce(`${label}:whisperPrompt:${id}`, `\u5BA0\u7269\u300C${id}\u300D\u7684 whisperPrompt \u975E\u6CD5\uFF0C\u5DF2\u5FFD\u7565\uFF08\u56DE\u843D\u6240\u5C5E\u6761\u76EE\u4EBA\u8BBE\uFF09`);
  }
  return {};
}
function readAllConfig(paths) {
  const base = readJsonc(paths.defaultFile);
  if (!base) throw new Error("dsh-pet: \u5185\u7F6E\u9ED8\u8BA4\u914D\u7F6E\u7F3A\u5931\u6216\u89E3\u6790\u5931\u8D25\uFF08\u5B89\u88C5\u635F\u574F\uFF09\uFF1A" + paths.defaultFile);
  const basePets = Array.isArray(base.pets) ? base.pets : [];
  const seenIds = /* @__PURE__ */ new Set();
  const out = {};
  const userFile = effectiveUserFile(paths);
  const mainOverlay = userFile ? readJsonc(userFile) : void 0;
  if (userFile && !mainOverlay) {
    warnOnce("file:" + userFile, "\u7528\u6237\u4E3B\u914D\u7F6E\u89E3\u6790\u5931\u8D25\uFF0C\u5DF2\u6309\u65E0\u7528\u6237\u914D\u7F6E\u5904\u7406\uFF1A" + userFile);
  }
  out.main = mergeEntry(base, mainOverlay, "main-config.jsonc", basePets, seenIds);
  const filePetBase = packBase(base, mainOverlay);
  for (const file of scanPetFiles(paths.petDir)) {
    const parsed = readJsonc(file.path);
    if (!parsed) {
      warnOnce("file:" + file.path, "\u6587\u4EF6\u5BA0\u7269\u914D\u7F6E\u89E3\u6790\u5931\u8D25\uFF0C\u5DF2\u8DF3\u8FC7\uFF1A" + file.path);
      continue;
    }
    out[file.prefix] = mergeEntry(filePetBase, parsed, file.prefix + "-config.json", basePets, seenIds);
  }
  return out;
}
function flattenPetList(merged) {
  const out = [];
  for (const conf of Object.values(merged)) {
    if (Array.isArray(conf?.pets)) out.push(...conf.pets);
  }
  return out;
}
function findPetInstance(merged, petId) {
  for (const [entry, conf] of Object.entries(merged)) {
    const pets = Array.isArray(conf?.pets) ? conf.pets : [];
    const found = pets.find((p) => String(p.id) === petId);
    if (found) return { entry, conf, pet: found };
  }
  return void 0;
}
function saveUserConfig(raw, existing) {
  const o = raw && typeof raw === "object" ? raw : {};
  const arr = Array.isArray(o.pets) ? o.pets : null;
  if (!arr || !arr.length) return null;
  const out = [];
  for (const p of arr) {
    if (!p || typeof p !== "object") return null;
    const pp = p;
    const id = String(pp.id ?? "");
    if (!id || id.length > 64 || ID_FORBIDDEN.test(id)) return null;
    const size = Number(pp.size);
    if (!Number.isFinite(size) || size <= 0) return null;
    let name = typeof pp.name === "string" ? pp.name.trim() : "";
    if (!name) {
      console.warn(`dsh-pet: pet\u300C${id}\u300D\u7F3A\u5C11 name\uFF0C\u5DF2\u6309\u9ED8\u8BA4 ${id}\uFF08\u5BA0\u7269 id\uFF09\u5904\u7406`);
      name = id;
    }
    const balanceEnabled = pp.balanceEnabled;
    if (typeof balanceEnabled !== "boolean") return null;
    const whisperEnabled = pp.whisperEnabled;
    if (whisperEnabled !== void 0 && typeof whisperEnabled !== "boolean") return null;
    const workStatusEnabled = pp.workStatusEnabled;
    if (workStatusEnabled !== void 0 && typeof workStatusEnabled !== "boolean") return null;
    const fixedEnabled = pp.fixedEnabled;
    if (fixedEnabled !== void 0 && typeof fixedEnabled !== "boolean") return null;
    const display = String(pp.display ?? "");
    if (!PET_DISPLAY_SET.has(display)) return null;
    const pos = pp.position && typeof pp.position === "object" ? pp.position : {};
    const corner = String(pos.corner ?? "");
    if (!CORNER_SET.has(corner)) return null;
    const marginX = Number(pos.marginX);
    const marginY = Number(pos.marginY);
    if (!Number.isFinite(marginX) || !Number.isFinite(marginY)) return null;
    const rawPersona = pp.whisperPrompt;
    if (rawPersona !== void 0 && rawPersona !== null && typeof rawPersona !== "string") return null;
    const persona = typeof rawPersona === "string" ? rawPersona.trim() : "";
    const pet = {
      id,
      name,
      size,
      balanceEnabled,
      whisperEnabled,
      workStatusEnabled,
      fixedEnabled,
      display,
      position: { corner, marginX, marginY }
    };
    if (persona) pet.whisperPrompt = persona;
    out.push(pet);
  }
  const ne = o.notificationsEnabled;
  if (ne !== void 0 && typeof ne !== "boolean") return null;
  const wie = o.whisperImageEnabled;
  if (wie !== void 0 && typeof wie !== "boolean") return null;
  const cie = o.chatImageEnabled;
  if (cie !== void 0 && typeof cie !== "boolean") return null;
  const cts = o.confineToScreen;
  if (cts !== void 0 && typeof cts !== "boolean") return null;
  const ph = o.physics;
  if (ph !== void 0 && !physicsValid(ph)) return null;
  const fo = o.font;
  if (fo !== void 0 && !fontValid(fo)) return null;
  const wm = o.whisperModel;
  if (wm !== void 0 && !modelSelectionValid(wm)) return null;
  const cm = o.chatModel;
  if (cm !== void 0 && !modelSelectionValid(cm)) return null;
  const cmr = o.chatMemoryRounds;
  if (cmr !== void 0 && !topFieldValid("chatMemoryRounds", cmr)) return null;
  const cil = o.chatImageLimit;
  if (cil !== void 0 && !topFieldValid("chatImageLimit", cil)) return null;
  const cleanModel = (v) => ({
    provider: String(v.provider).trim(),
    model: String(v.model).trim()
  });
  const outConfig = { pets: out };
  if (ne !== void 0) outConfig.notificationsEnabled = ne;
  if (wie !== void 0) outConfig.whisperImageEnabled = wie;
  if (cie !== void 0) outConfig.chatImageEnabled = cie;
  if (cts !== void 0) outConfig.confineToScreen = cts;
  if (ph !== void 0) outConfig.physics = ph;
  if (fo !== void 0) outConfig.font = fo;
  if (wm !== void 0) outConfig.whisperModel = cleanModel(wm);
  if (cm !== void 0) outConfig.chatModel = cleanModel(cm);
  if (cmr !== void 0) outConfig.chatMemoryRounds = Number(cmr);
  if (cil !== void 0) outConfig.chatImageLimit = Number(cil);
  const bodyOwned = /* @__PURE__ */ new Set(["pets"]);
  if (ne !== void 0) bodyOwned.add("notificationsEnabled");
  if (wie !== void 0) bodyOwned.add("whisperImageEnabled");
  if (cie !== void 0) bodyOwned.add("chatImageEnabled");
  if (cts !== void 0) bodyOwned.add("confineToScreen");
  if (ph !== void 0) bodyOwned.add("physics");
  if (fo !== void 0) bodyOwned.add("font");
  if (wm !== void 0) bodyOwned.add("whisperModel");
  if (cm !== void 0) bodyOwned.add("chatModel");
  if (cmr !== void 0) bodyOwned.add("chatMemoryRounds");
  if (cil !== void 0) bodyOwned.add("chatImageLimit");
  if (existing && typeof existing === "object") {
    for (const key of Object.keys(existing)) {
      if (bodyOwned.has(key)) continue;
      outConfig[key] = existing[key];
    }
  }
  return outConfig;
}
function syncUserConfigFromDefault(paths) {
  const raw = readFileSync(paths.defaultFile, "utf8");
  mkdirSync2(dirname2(paths.userFile), { recursive: true });
  writeFileSync(paths.userFile, raw, "utf8");
}
function sliceMemoryRounds(messages, rounds) {
  return rounds > 0 ? messages.slice(-Math.floor(rounds) * 2) : [];
}

// upstream/src/host/anim.ts
function strings(v) {
  return Array.isArray(v) ? v.filter((x) => typeof x === "string" && x !== "") : [];
}
var petFacing = (v) => v === "left" || v === "right" ? v : null;
function animationNames(animations) {
  const a = animations && typeof animations === "object" ? animations : {};
  const out = [];
  const push = (names) => {
    for (const n of names) if (!out.includes(n)) out.push(n);
  };
  push(strings(a.idle));
  push(strings(a.turn));
  push(strings(a.drag));
  push(strings(a.clicks));
  const moves = a.moves && typeof a.moves === "object" ? a.moves : {};
  push(
    Array.isArray(moves.actions) ? moves.actions.map((m) => m && typeof m === "object" ? m.name : void 0).filter((x) => typeof x === "string" && x !== "") : []
  );
  if (Array.isArray(a.categories)) {
    for (const c of a.categories) {
      if (c && typeof c === "object") push(strings(c.actions));
    }
  }
  const events = a.events && typeof a.events === "object" ? a.events : {};
  for (const key of Object.keys(events)) {
    const pool = events[key];
    if (!Array.isArray(pool)) continue;
    const names = [];
    for (const slot of pool) {
      if (typeof slot === "string") names.push(slot);
      else names.push(...strings(slot));
    }
    push(names);
  }
  return out;
}
function normalizeHttpUrl(v) {
  if (typeof v !== "string") return null;
  const raw = v.trim();
  if (!raw) return null;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  return raw;
}
function decideAnim(args) {
  const { cfg, requested } = args;
  const name = typeof args.name === "string" ? args.name.trim() : "";
  const rawUrl = typeof args.url === "string" ? args.url.trim() : "";
  if (name && rawUrl) return { ok: false, reason: "bad-request", message: "name \u4E0E url \u53EA\u80FD\u7ED9\u4E00\u4E2A" };
  if (!name && !rawUrl) return { ok: false, reason: "bad-request", message: "name \u6216 url \u5FC5\u987B\u7ED9\u4E00\u4E2A" };
  let facing;
  if (args.facing !== void 0 && args.facing !== null) {
    const f = petFacing(args.facing);
    if (f === null) return { ok: false, reason: "bad-request", message: "facing \u5FC5\u987B\u662F left / right" };
    facing = f;
  }
  const petId = String(requested ?? "").trim();
  if (!petId) return { ok: false, reason: "pet-required", message: "pet \u5FC5\u586B\uFF1A\u8981\u6307\u5B9A\u64CD\u4F5C\u54EA\u53EA\u684C\u5BA0" };
  const found = findPetInstance(cfg, petId);
  if (!found) return { ok: false, reason: "unknown-pet", message: "\u6CA1\u6709\u8FD9\u53EA\u684C\u5BA0\uFF1A" + petId };
  if (rawUrl) {
    const url = normalizeHttpUrl(rawUrl);
    if (url === null) {
      return { ok: false, reason: "bad-request", message: "url \u5FC5\u987B\u662F http/https \u7684\u5B8C\u6574\u5730\u5740" };
    }
    return { ok: true, petId, url, facing };
  }
  const allowed = animationNames(found.conf.animations);
  if (!allowed.includes(name)) {
    return { ok: false, reason: "unknown-animation", message: "\u6CA1\u6709\u8FD9\u4E2A\u52A8\u753B\uFF1A" + name };
  }
  return { ok: true, petId, name, facing };
}

// upstream/src/host/broadcast.ts
var DEFAULT_BUBBLE_DURATION_MS = 10 * 1e3;
function normalizeBroadcastText(text) {
  return typeof text === "string" ? text.trim() : "";
}
function normalizeBroadcastDuration(duration) {
  if (duration === void 0 || duration === null) return DEFAULT_BUBBLE_DURATION_MS;
  if (typeof duration !== "number" || !Number.isFinite(duration) || duration < 0) return null;
  return duration;
}
function normalizeBroadcastAnim(anim) {
  return anim !== false;
}
function resolvePetId(cfg, requested) {
  const petId = String(requested ?? "").trim();
  if (!petId) return { ok: false, reason: "pet-required", message: "pet \u5FC5\u586B\uFF1A\u8981\u6307\u5B9A\u64CD\u4F5C\u54EA\u53EA\u684C\u5BA0" };
  const found = findPetInstance(cfg, petId);
  if (!found) return { ok: false, reason: "unknown-pet", message: "\u6CA1\u6709\u8FD9\u53EA\u684C\u5BA0\uFF1A" + petId };
  return { ok: true, petId, entry: found.entry, conf: found.conf };
}
function decideBroadcast(args) {
  const { cfg, requested, memeDirs } = args;
  const text = normalizeBroadcastText(args.text);
  if (!text) return { ok: false, reason: "bad-request", message: "text \u4E3A\u7A7A" };
  const who = resolvePetId(cfg, requested);
  if (!who.ok) return { ok: false, reason: who.reason, message: who.message };
  const petId = who.petId;
  const rawImage = typeof args.image === "string" ? args.image.trim() : "";
  const rawUrl = typeof args.url === "string" ? args.url.trim() : "";
  if (rawImage && rawUrl) return { ok: false, reason: "bad-request", message: "image \u4E0E url \u53EA\u80FD\u7ED9\u4E00\u4E2A" };
  if (!rawImage && !rawUrl) return { ok: true, petId, text, duration: args.duration, anim: args.anim };
  if (rawUrl) {
    const url = normalizeHttpUrl(rawUrl);
    if (url === null) {
      return { ok: false, reason: "bad-request", message: "url \u5FC5\u987B\u662F http/https \u7684\u5B8C\u6574\u5730\u5740" };
    }
    return { ok: true, petId, text, url, duration: args.duration, anim: args.anim };
  }
  const hit = matchMeme(readMemePool(who.conf.memes, memeDirs(who.entry)), rawImage);
  if (!hit) {
    return { ok: false, reason: "unknown-image", message: "\u914D\u56FE\u4E0D\u5728\u8868\u60C5\u5305\u6C60\u5185\uFF1A" + rawImage };
  }
  return { ok: true, petId, text, image: hit.name, duration: args.duration, anim: args.anim };
}
function decideBubbleClear(args) {
  const who = resolvePetId(args.cfg, args.requested);
  if (!who.ok) return { ok: false, reason: who.reason, message: who.message };
  return { ok: true, petId: who.petId };
}

// upstream/src/host/lock.ts
var LOCK_DEFAULT_TTL_MS = 2 * 60 * 1e3;
var LOCK_MIN_TTL_MS = 1 * 1e3;
var LOCK_MAX_TTL_MS = 30 * 60 * 1e3;
var CAUSE_TEXT = {
  expired: "\u5360\u7528\u5DF2\u8FC7\u671F\uFF08\u6CA1\u6709\u53CA\u65F6\u7EED\u671F\uFF09",
  released: "\u5360\u7528\u5DF2\u88AB\u91CA\u653E",
  preempted: "\u5360\u7528\u5DF2\u88AB\u7528\u6237\u63A5\u7BA1\uFF08\u62D6\u62FD/\u70B9\u51FB/\u9690\u85CF/\u5173\u95ED\uFF09",
  unknown: "lock \u4E0D\u662F\u5F53\u524D\u751F\u6548\u7684\u5360\u7528\u7F16\u53F7"
};
var TTL_TEXT = `ttl \u5FC5\u987B\u662F ${LOCK_MIN_TTL_MS}~${LOCK_MAX_TTL_MS} \u4E4B\u95F4\u7684\u6709\u9650\u6570\u5B57\uFF08\u6BEB\u79D2\uFF09`;
function normalizeLockTtl(ttl, fallback) {
  if (ttl === void 0 || ttl === null) return fallback;
  if (typeof ttl !== "number" || !Number.isFinite(ttl)) return null;
  if (ttl < LOCK_MIN_TTL_MS || ttl > LOCK_MAX_TTL_MS) return null;
  return ttl;
}
function normalizeLockId(v) {
  if (v === void 0 || v === null) return "";
  if (typeof v !== "string") return null;
  return v.trim();
}
var LockStore = class {
  constructor(opts) {
    this.locks = /* @__PURE__ */ new Map();
    this.tombstones = /* @__PURE__ */ new Map();
    this.seq = 0;
    this.now = opts?.now ?? Date.now;
    this.onChange = opts?.onChange ?? (() => {
    });
  }
  /**
   * 当前占用（**懒判过期**）。到点即视为没有：清记录、记墓碑、同步一次叶子。
   *
   * 这里会写叶子（读方法带一次副作用）是有意的：叶子是渲染端唯一能看到的信号，
   * 而宿主这一侧没有任何定时器。任一动作端点或内部来源调一次本方法，过期的锁就会被清掉并
   * 如实写进 S；即便一次都没人调，渲染端也会按叶子里的 `expiresAt` **自己**解除静止。
   */
  current(petId) {
    const rec = this.locks.get(petId);
    if (rec === void 0) return null;
    if (this.now() < rec.expiresAt) return rec;
    this.drop(petId, rec, "expired");
    return null;
  }
  /** 这只宠物此刻是否被占用（宿主内部自动来源用它决定跳过；同样懒判过期） */
  locked(petId) {
    return this.current(petId) !== null;
  }
  /**
   * 当前是否有**任意**宠物被占用（测试 / 观测用，同 ./state 的 `waiterCount()`）。
   *
   * **生产路径上没有人调它**：占用期间要挡的两个**全局段**（`sections.balance` /
   * `sections.workStatus`）是**所有宠物共用一份**，宿主"跳过写入"会连带静音别的宠物
   * （issue #122 要的是"只控制指定 main"），所以那两处改由**渲染端按宠物忽略**——
   * 叶子照常推进，被占用那只自己不看（见 src/client/pet.ts 的冻结判定与
   * runtime/electron-helper/events.js 里同一处判断）。宿主侧只挡 per-pet 的碎碎念周期。
   */
  anyLocked() {
    for (const petId of [...this.locks.keys()]) {
      if (this.current(petId) !== null) return true;
    }
    return false;
  }
  /**
   * 动作端点的门禁（`/anim`、`/broadcast`、`/position`、`/throw`、`/bubble/clear` 共用）。
   *
   * 无锁时按「有没有带编号」分两条：
   *   - **没带 `lock`** → 放行。没有占用的常态下，既有调用方一个字都不用改。
   *   - **带了 `lock` 但查不到锁** → `lock-lost`。带了编号就说明调用方以为自己还持有；这时放行
   *     等于把「你把锁丢了」悄悄抹掉，它会以为演出还在继续。`cause` 从墓碑里取，从没建过锁就是
   *     `unknown`（issue #122 第 4 点：旧租约不能继续执行迟到请求）。
   */
  gate(petId, provided) {
    const rec = this.current(petId);
    if (rec !== null) {
      if (provided && provided === rec.lockId) return { ok: true };
      if (!provided) {
        return { ok: false, reason: "lock-required", message: "\u8FD9\u53EA\u684C\u5BA0\u6B63\u88AB\u5360\u7528\uFF0C\u5FC5\u987B\u5E26 lock=<lockId>" };
      }
      return { ok: false, reason: "lock-lost", cause: "unknown", message: CAUSE_TEXT.unknown };
    }
    if (!provided) return { ok: true };
    const cause = this.causeOf(petId, provided);
    return { ok: false, reason: "lock-lost", cause, message: CAUSE_TEXT[cause] };
  }
  /**
   * 取锁 / 续期（**二合一**：`lockId` 给了就是续期，没给就是新建）。
   *
   * 真值表（每一格都有确定结论，不替调用方猜）：
   *   | body       | 当前锁       | 结论 |
   *   | 无 lockId  | 无锁         | 新建 |
   *   | 无 lockId  | 有锁         | `locked` + `expiresAt` |
   *   | 有 lockId  | 一致         | 续期 |
   *   | 有 lockId  | 有锁但不一致 | `lock-lost` / `unknown` |
   *   | 有 lockId  | 无锁         | `lock-lost` / 墓碑里的 cause |
   *
   * **「有 id + 当前无锁」一律报错，不复活**：过期/被释放/被抢占之后拿旧编号来续期，
   * 不能借这条路把锁重新建起来——否则「我丢了锁」这件事会被悄悄抹掉，持锁者会以为演出还在继续。
   */
  acquire(args) {
    const { petId } = args;
    const renewId = normalizeLockId(args.lockId);
    if (renewId === null) return { ok: false, reason: "bad-request", message: "lockId \u5FC5\u987B\u662F\u5B57\u7B26\u4E32" };
    const rec = this.current(petId);
    if (renewId) {
      if (rec === null || rec.lockId !== renewId) {
        const cause = rec === null ? this.causeOf(petId, renewId) : "unknown";
        return { ok: false, reason: "lock-lost", cause, message: CAUSE_TEXT[cause] };
      }
      const ttl2 = normalizeLockTtl(args.ttl, rec.ttl);
      if (ttl2 === null) return { ok: false, reason: "bad-request", message: TTL_TEXT };
      rec.ttl = ttl2;
      rec.expiresAt = this.now() + ttl2;
      this.onChange(petId, { locked: true, expiresAt: rec.expiresAt });
      return { ok: true, petId, lockId: rec.lockId, expiresAt: rec.expiresAt, renewed: true };
    }
    if (rec !== null) {
      return { ok: false, reason: "locked", expiresAt: rec.expiresAt, message: "\u8FD9\u53EA\u684C\u5BA0\u5DF2\u88AB\u5360\u7528" };
    }
    const ttl = normalizeLockTtl(args.ttl, LOCK_DEFAULT_TTL_MS);
    if (ttl === null) return { ok: false, reason: "bad-request", message: TTL_TEXT };
    const record = { lockId: this.newId(), ttl, expiresAt: this.now() + ttl };
    this.locks.set(petId, record);
    this.tombstones.delete(petId);
    this.onChange(petId, { locked: true, expiresAt: record.expiresAt });
    return { ok: true, petId, lockId: record.lockId, expiresAt: record.expiresAt, renewed: false };
  }
  /**
   * 释放。两种形态**二选一**：
   *   - `lockId`：持锁者收工 → `cause: released`
   *   - `force: true`：**渲染端**在用户拖拽/点击/隐藏/关闭时调 → `cause: preempted`
   *
   * 幂等：当前没有锁时回 `ok:true`（`released: false`）——"让锁消失"这个意图在空状态下已经成立。
   * 但有锁而 `lockId` 不匹配时**必须报错**（不许误放别人的锁）：这是唯一一条"释放也会失败"的路。
   *
   * `force` 只认**严格 `true`**（宽松口径会把误传当真，代价是撤掉别人的锁——宁可严格）。
   */
  release(args) {
    const { petId } = args;
    const force = args.force === true;
    const releaseId = normalizeLockId(args.lockId);
    if (releaseId === null) return { ok: false, reason: "bad-request", message: "lockId \u5FC5\u987B\u662F\u5B57\u7B26\u4E32" };
    if (force && releaseId) {
      return { ok: false, reason: "bad-request", message: "lockId \u4E0E force \u53EA\u80FD\u7ED9\u4E00\u4E2A" };
    }
    if (!force && !releaseId) {
      return { ok: false, reason: "bad-request", message: "lockId \u6216 force \u5FC5\u987B\u7ED9\u4E00\u4E2A" };
    }
    const rec = this.current(petId);
    if (rec === null) return { ok: true, petId, released: false };
    if (!force && rec.lockId !== releaseId) {
      return { ok: false, reason: "lock-lost", cause: "unknown", message: CAUSE_TEXT.unknown };
    }
    this.drop(petId, rec, force ? "preempted" : "released");
    return { ok: true, petId, released: true };
  }
  /** 撤掉全部占用（插件卸载路径）：不这样做的话，渲染端要等 TTL 到点才解除静止 */
  releaseAll() {
    for (const petId of [...this.locks.keys()]) {
      const rec = this.locks.get(petId);
      if (rec !== void 0) this.drop(petId, rec, "released");
    }
  }
  /** 撤锁并记墓碑（唯一改状态的出口：释放/抢占/过期都走它，保证叶子与墓碑不漏写） */
  drop(petId, rec, cause) {
    this.locks.delete(petId);
    this.tombstones.set(petId, { lockId: rec.lockId, cause });
    this.onChange(petId, { locked: false });
  }
  /** 墓碑查询：编号对得上就回它当初的 cause，否则 unknown（拿错编号 / 从来没有过） */
  causeOf(petId, lockId) {
    const stone = this.tombstones.get(petId);
    return stone !== void 0 && stone.lockId === lockId ? stone.cause : "unknown";
  }
  /** 新编号：`lk-<时间36>-<自增36>`（与 ./playback 的 playbackId 同一套，只保证一次运行内唯一） */
  newId() {
    return "lk-" + this.now().toString(36) + "-" + (++this.seq).toString(36);
  }
};

// upstream/src/host/menu.ts
var OWNER_MAX = 64;
var LABEL_MAX = 32;
var ITEMS_MAX = 20;
var OWNERS_MAX = 32;
var MENU_WAIT_MAX_MS = 1e4;
var CONTROL_CHARS = /[\x00-\x1f\x7f]/;
function displayText(value, max) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (text === "" || text.length > max || CONTROL_CHARS.test(text)) return null;
  return text;
}
var MenuRegistry = class {
  constructor() {
    this.owners = /* @__PURE__ */ new Map();
    this.waiters = /* @__PURE__ */ new Map();
  }
  /**
   * 注册（整体覆盖）：`{ owner, labels: string[] }`。
   *
   * 覆盖的粒度是 **owner 的全部菜单项**，不是逐项 upsert：这样注册方每次都能用一份完整列表
   * 描述"我现在有什么"，不必关心上次注册了什么，也不会留下已下线的僵尸项。
   */
  register(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return { ok: false, reason: "bad-request", message: "body \u5FC5\u987B\u662F { owner, labels }" };
    }
    const body = raw;
    const owner = displayText(body.owner, OWNER_MAX);
    if (owner === null) {
      return { ok: false, reason: "invalid-owner", message: `owner \u5FC5\u987B\u662F 1\u2013${OWNER_MAX} \u5B57\u7B26\u7684\u5B57\u7B26\u4E32\uFF08\u7981\u63A7\u5236\u5B57\u7B26\uFF09` };
    }
    const rawLabels = body.labels;
    if (!Array.isArray(rawLabels) || rawLabels.length === 0) {
      return { ok: false, reason: "invalid-labels", message: "labels \u5FC5\u987B\u662F\u975E\u7A7A\u6570\u7EC4" };
    }
    if (rawLabels.length > ITEMS_MAX) {
      return { ok: false, reason: "too-many-items", message: `\u6BCF\u4E2A owner \u6700\u591A ${ITEMS_MAX} \u9879` };
    }
    const labels = [];
    for (const rawLabel of rawLabels) {
      const label = displayText(rawLabel, LABEL_MAX);
      if (label === null) {
        return { ok: false, reason: "invalid-label", message: `\u6BCF\u4E2A label \u5FC5\u987B\u662F 1\u2013${LABEL_MAX} \u5B57\u7B26\u7684\u5B57\u7B26\u4E32\uFF08\u7981\u63A7\u5236\u5B57\u7B26\uFF09` };
      }
      if (!labels.includes(label)) labels.push(label);
    }
    if (!this.owners.has(owner) && this.owners.size >= OWNERS_MAX) {
      return { ok: false, reason: "too-many-owners", message: `\u6700\u591A ${OWNERS_MAX} \u4E2A owner` };
    }
    this.owners.set(owner, new Map(labels.map((label) => [label, null])));
    return { ok: true };
  }
  /**
   * 清掉一个 owner 的全部菜单项（连它上面未取走的触发标记一起丢）。
   *
   * 幂等：owner 本来就不存在 → `removed: 0`，仍算成功——调用方重试注销时不该看到错误。
   * 挂在该 owner 上的长轮询会被叫醒，醒来后查不到 owner → `null`（路由回 `ok:false` +
   * `unknown-owner`），调用方据此知道要重新注册。
   */
  clear(rawOwner) {
    const owner = displayText(rawOwner, OWNER_MAX);
    if (owner === null) {
      return { ok: false, reason: "invalid-owner", message: `owner \u5FC5\u987B\u662F 1\u2013${OWNER_MAX} \u5B57\u7B26\u7684\u5B57\u7B26\u4E32\uFF08\u7981\u63A7\u5236\u5B57\u7B26\uFF09` };
    }
    const items = this.owners.get(owner);
    if (!items) return { ok: true, removed: 0 };
    const removed = items.size;
    this.owners.delete(owner);
    const waiters = this.waiters.get(owner);
    this.waiters.delete(owner);
    if (waiters) for (const wake of [...waiters]) wake();
    return { ok: true, removed };
  }
  /** 全量快照（写进 state；顺序 = 注册顺序 + 列表顺序，两端渲染顺序与它一致） */
  snapshot() {
    const out = [];
    for (const [owner, items] of this.owners) {
      for (const label of items.keys()) out.push({ owner, label });
    }
    return out;
  }
  /**
   * 渲染端上报一次点击：把该项标成"被 petId 点了"，并叫醒该 owner 上挂着的长轮询。
   *
   * `delivered = false`（项不存在：菜单刚好被覆盖/还没注册）**不算错误**——渲染端拿着的是
   * 上一拍 /state 的快照，这一拍菜单已经变了，属于正常竞态，路由仍回 200。
   */
  click(raw) {
    const body = raw && typeof raw === "object" ? raw : {};
    const owner = typeof body.owner === "string" ? body.owner : "";
    const label = typeof body.label === "string" ? body.label : "";
    const pet = typeof body.pet === "string" ? body.pet.trim() : "";
    const items = this.owners.get(owner);
    if (!items || !items.has(label) || pet === "") return { ok: true, delivered: false };
    items.set(label, pet);
    const waiters = this.waiters.get(owner);
    if (waiters) for (const wake of [...waiters]) wake();
    return { ok: true, delivered: true };
  }
  /**
   * 查询触发：返回 `{ label: petId | null }` 全量映射，**返回即清空**这些标记。
   *
   * `waitMs > 0` 且当下没有任何触发 → 挂起等待（该 owner 被点/超时/被覆盖都会唤醒），
   * 超时后照常返回全 null 的映射。owner 不存在 → null（路由回 404，调用方据此知道要重新注册）。
   */
  async poll(owner, waitMs) {
    const items = this.owners.get(owner);
    if (!items) return null;
    if (waitMs > 0 && !hasFired(items)) {
      await new Promise((resolve3) => {
        const set = this.waiters.get(owner) ?? /* @__PURE__ */ new Set();
        this.waiters.set(owner, set);
        const hold = {};
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          if (hold.timer !== void 0) clearTimeout(hold.timer);
          set.delete(finish);
          if (set.size === 0 && this.waiters.get(owner) === set) this.waiters.delete(owner);
          resolve3();
        };
        hold.timer = setTimeout(finish, Math.min(waitMs, MENU_WAIT_MAX_MS));
        set.add(finish);
      });
    }
    const current = this.owners.get(owner);
    if (!current) return null;
    const out = {};
    for (const [label, pet] of current) {
      out[label] = pet;
      current.set(label, null);
    }
    return out;
  }
};
function hasFired(items) {
  for (const pet of items.values()) if (pet !== null) return true;
  return false;
}

// upstream/src/host/motion-cue.ts
var POSITION_MODES = ["instant", "spring", "line"];
var clamp01 = (v) => Math.min(1, Math.max(0, v));
var finite = (v) => typeof v === "number" && Number.isFinite(v) ? v : null;
var positionMode = (v) => typeof v === "string" && POSITION_MODES.includes(v) ? v : null;
function resolvePet(cfg, requested) {
  const petId = String(requested ?? "").trim();
  if (!petId) return { ok: false, reason: "pet-required", message: "pet \u5FC5\u586B\uFF1A\u8981\u6307\u5B9A\u64CD\u4F5C\u54EA\u53EA\u684C\u5BA0" };
  if (!flattenPetList(cfg).some((p) => String(p.id) === petId)) {
    return { ok: false, reason: "unknown-pet", message: "\u6CA1\u6709\u8FD9\u53EA\u684C\u5BA0\uFF1A" + petId };
  }
  return { ok: true, petId };
}
function decidePosition(args) {
  const x = finite(args.x);
  if (x === null) return { ok: false, reason: "bad-request", message: "x \u5FC5\u987B\u662F\u6709\u9650\u6570\u5B57" };
  const y = finite(args.y);
  if (y === null) return { ok: false, reason: "bad-request", message: "y \u5FC5\u987B\u662F\u6709\u9650\u6570\u5B57" };
  const mode = positionMode(args.mode);
  if (mode === null) {
    return { ok: false, reason: "bad-request", message: "mode \u5FC5\u987B\u662F instant / spring / line" };
  }
  let duration = null;
  if (mode === "line") {
    const d = finite(args.duration);
    if (d === null || d < 0) {
      return { ok: false, reason: "bad-request", message: "line \u6A21\u5F0F\u7684 duration \u5FC5\u987B\u662F\u975E\u8D1F\u6709\u9650\u6570\u5B57\uFF08\u6BEB\u79D2\uFF09" };
    }
    duration = d;
  }
  const pet = resolvePet(args.cfg, args.requested);
  if (!pet.ok) return pet;
  return { ok: true, petId: pet.petId, x: clamp01(x), y: clamp01(y), mode, duration };
}
var positionLeafData = (d) => d.duration === null ? { x: d.x, y: d.y, mode: d.mode } : { x: d.x, y: d.y, mode: d.mode, duration: d.duration };
function decideThrow(args) {
  const angle = finite(args.angle);
  if (angle === null) return { ok: false, reason: "bad-request", message: "angle \u5FC5\u987B\u662F\u6709\u9650\u6570\u5B57" };
  const power = finite(args.power);
  if (power === null || power <= 0) {
    return { ok: false, reason: "bad-request", message: "power \u5FC5\u987B\u662F\u5927\u4E8E 0 \u7684\u6709\u9650\u6570\u5B57" };
  }
  const pet = resolvePet(args.cfg, args.requested);
  if (!pet.ok) return pet;
  return { ok: true, petId: pet.petId, angle, power };
}

// upstream/src/host/playback.ts
var TERMINAL_STATUSES = ["ended", "failed", "cancelled"];
var REPORTABLE_STATUSES = ["playing", "ended", "failed", "cancelled"];
var PLAYBACK_KEEP_MS = 60 * 1e3;
var MAX_PLAYBACK_WAIT_MS = 10 * 1e3;
var TERMINAL = new Set(TERMINAL_STATUSES);
var REPORTABLE = new Set(REPORTABLE_STATUSES);
var isTerminalStatus = (s) => TERMINAL.has(s);
var isPlaybackStatus = (s) => s === "accepted" || REPORTABLE.has(s);
var isReportableStatus = (s) => REPORTABLE.has(s);
function parsePlaybackPath(rest) {
  const m = /^playback\/([^/]+)(\/report)?$/.exec(rest);
  if (!m) return void 0;
  return { playbackId: m[1] ?? "", isReport: m[2] === "/report" };
}
function parseWaitQuery(waitRaw, timeoutRaw) {
  if (waitRaw === null && timeoutRaw === null) return { kind: "none" };
  if (waitRaw === null || timeoutRaw === null) {
    return { kind: "error", error: "wait and timeout must be used together" };
  }
  const wait = waitRaw.split(",").map((s) => s.trim()).filter((s) => s !== "");
  const bad = wait.find((s) => !isPlaybackStatus(s));
  if (wait.length === 0 || bad !== void 0) {
    return { kind: "error", error: `invalid wait status: ${bad ?? waitRaw}` };
  }
  if (!/^\d+$/.test(timeoutRaw)) {
    return { kind: "error", error: `invalid timeout (expect 0..${MAX_PLAYBACK_WAIT_MS})` };
  }
  const timeoutMs = Number(timeoutRaw);
  if (!Number.isFinite(timeoutMs) || timeoutMs > MAX_PLAYBACK_WAIT_MS) {
    return { kind: "error", error: `invalid timeout (expect 0..${MAX_PLAYBACK_WAIT_MS})` };
  }
  return { kind: "ok", wait, timeoutMs };
}
var PlaybackStore = class {
  constructor() {
    this.records = /* @__PURE__ */ new Map();
    this.waiters = /* @__PURE__ */ new Map();
    this.activeByPet = /* @__PURE__ */ new Map();
    this.seq = 0;
  }
  /**
   * 受理一次点播：建记录（accepted），并把该宠物上一场（若仍在非终态）标为 cancelled/superseded。
   * @returns 新建的记录（调用方取 playbackId 下发给调用方）
   */
  create(petId, name) {
    this.sweep();
    const prev = this.activeByPet.get(petId);
    if (prev !== void 0) this.finish(prev, "cancelled", "superseded");
    const now = Date.now();
    const record = {
      playbackId: "pb-" + now.toString(36) + "-" + (++this.seq).toString(36),
      petId,
      name,
      status: "accepted",
      createdAt: now,
      updatedAt: now
    };
    this.records.set(record.playbackId, record);
    this.activeByPet.set(petId, record.playbackId);
    return record;
  }
  /** 查记录；不存在 / 已过期 → undefined（路由回 404） */
  get(playbackId) {
    this.sweep();
    return this.records.get(playbackId);
  }
  /**
   * 渲染端上报一次状态。
   *
   * 幂等与终态保护：**终态之后的上报一律 ignored**（迟到的 ended 不许覆盖 cancelled），
   * 与当前状态相同的上报同样 ignored。两种情况路由都回 200——对上报方来说"已经这样了"就是成功。
   */
  report(playbackId, status, reason) {
    this.sweep();
    const record = this.records.get(playbackId);
    if (!record) return "unknown";
    const next = typeof status === "string" ? status : "";
    if (!isReportableStatus(next)) return "invalid";
    if (isTerminalStatus(record.status) || record.status === next) return "ignored";
    const why = typeof reason === "string" && reason !== "" ? reason : void 0;
    this.finish(playbackId, next, why);
    return "ok";
  }
  /**
   * 挂起一个等待者。
   * @returns 取消函数；编号不存在时返回 **undefined**（路由据此立刻回 404，不挂）
   */
  wait(args) {
    this.sweep();
    const record = this.records.get(args.playbackId);
    if (!record) return void 0;
    const waiter = {
      wait: new Set(args.wait),
      onWake: args.onWake,
      record,
      timer: void 0
    };
    let set = this.waiters.get(args.playbackId);
    if (!set) {
      set = /* @__PURE__ */ new Set();
      this.waiters.set(args.playbackId, set);
    }
    set.add(waiter);
    waiter.timer = setTimeout(
      () => {
        this.dropWaiter(args.playbackId, waiter);
        waiter.onWake(waiter.record, false);
      },
      Math.max(0, args.timeoutMs)
    );
    waiter.timer.unref?.();
    return () => this.dropWaiter(args.playbackId, waiter);
  }
  /**
   * 结束**所有**挂起的等待（插件卸载 / 宿主退出路径）。
   * 唤醒时 matched=false：调用方据此立刻收尾，而不是留一个悬挂的响应。
   */
  cancelAll() {
    for (const [playbackId, set] of [...this.waiters]) {
      for (const waiter of [...set]) {
        this.dropWaiter(playbackId, waiter);
        waiter.onWake(waiter.record, false);
      }
    }
  }
  /**
   * 清理过期终态记录（惰性调用：create / get / report 各调一次，记录数很少，成本可忽略）。
   *
   * **必须先把还在等它的人叫醒**：等待上限（10s）通常远小于保留时长（60s），但调用方完全可以在
   * 一条终态记录的保留窗口末尾注册一个等"别的状态"的等待者——那种情况下记录会被清理，
   * 不唤醒就成了永远等不到的悬挂等待者。
   *
   * @param now 注入时间（单测用；缺省取当前时刻）
   */
  sweep(now = Date.now()) {
    for (const [playbackId, record] of this.records) {
      if (!isTerminalStatus(record.status)) continue;
      if (now - record.updatedAt < PLAYBACK_KEEP_MS) continue;
      const set = this.waiters.get(playbackId);
      if (set) {
        for (const waiter of [...set]) {
          this.dropWaiter(playbackId, waiter);
          waiter.onWake(waiter.record, false);
        }
      }
      this.records.delete(playbackId);
    }
  }
  /** 当前记录数（测试 / 观测用） */
  count() {
    return this.records.size;
  }
  /** 当前等待者数（测试 / 观测用：验证不泄漏） */
  waiterCount() {
    let n = 0;
    for (const set of this.waiters.values()) n += set.size;
    return n;
  }
  /**
   * 落到一个终态：写状态、更新时间、摘掉"当前活跃"、唤醒在等这个状态的人。
   * 唯一的状态写入点——等待者唤醒只在这里发生（不需要 diff、不需要比对）。
   */
  finish(playbackId, status, reason) {
    const record = this.records.get(playbackId);
    if (!record) return;
    record.status = status;
    record.updatedAt = Date.now();
    if (status === "ended") record.endedAt = record.updatedAt;
    if (reason !== void 0) record.reason = reason;
    if (this.activeByPet.get(record.petId) === playbackId) this.activeByPet.delete(record.petId);
    const set = this.waiters.get(playbackId);
    if (!set) return;
    for (const waiter of [...set]) {
      if (!waiter.wait.has(status)) continue;
      this.dropWaiter(playbackId, waiter);
      waiter.onWake(waiter.record, true);
    }
  }
  /** 摘掉一个等待者（清定时器 + 从集合移除 + 空集合回收） */
  dropWaiter(playbackId, waiter) {
    if (waiter.timer !== void 0) {
      clearTimeout(waiter.timer);
      waiter.timer = void 0;
    }
    const set = this.waiters.get(playbackId);
    if (!set) return;
    set.delete(waiter);
    if (set.size === 0) this.waiters.delete(playbackId);
  }
};

// upstream/src/host/pose.ts
function normalizePoseInput(raw) {
  const o = raw && typeof raw === "object" ? raw : null;
  if (!o) return { ok: false, reason: "bad-request", message: "\u8BF7\u6C42\u4F53\u5FC5\u987B\u662F\u5BF9\u8C61\uFF1A{ x, y, facing }" };
  if (typeof o.x !== "number" || !Number.isFinite(o.x)) {
    return { ok: false, reason: "bad-request", message: "x \u5FC5\u987B\u662F\u6709\u9650\u6570\u5B57\uFF08\u5F52\u4E00\u5316\u6A2A\u5750\u6807\uFF09" };
  }
  if (typeof o.y !== "number" || !Number.isFinite(o.y)) {
    return { ok: false, reason: "bad-request", message: "y \u5FC5\u987B\u662F\u6709\u9650\u6570\u5B57\uFF08\u5F52\u4E00\u5316\u7EB5\u5750\u6807\uFF09" };
  }
  if (o.facing !== "left" && o.facing !== "right") {
    return { ok: false, reason: "bad-request", message: "facing \u5FC5\u987B\u662F left / right" };
  }
  return { ok: true, pose: { x: o.x, y: o.y, facing: o.facing } };
}
var PoseStore = class {
  constructor(opts) {
    this.byPet = /* @__PURE__ */ new Map();
    this.now = opts?.now ?? Date.now;
  }
  /** 覆盖一只宠物的实况（返回落定的快照，方便调用方断言） */
  set(petId, pose) {
    const snap = { x: pose.x, y: pose.y, facing: pose.facing, updatedAt: this.now() };
    this.byPet.set(petId, snap);
    return snap;
  }
  /** 读最近一次实况；从没上报过 → undefined（路由回 `pose-unavailable`） */
  get(petId) {
    return this.byPet.get(petId);
  }
  /** 当前快照数（测试 / 观测用） */
  count() {
    return this.byPet.size;
  }
};

// upstream/src/host/surface.ts
var SURFACES = ["web", "desktop", "both", "any"];
var SURFACE_TEXT = "surface \u5FC5\u586B\uFF1Aweb / desktop / both / any";
function normalizeSurface(v) {
  return typeof v === "string" && SURFACES.includes(v) ? v : null;
}
function displayCovers(want, display) {
  switch (want) {
    case "any":
      return display === "web" || display === "desktop" || display === "both";
    case "web":
      return display === "web" || display === "both";
    case "desktop":
      return display === "desktop" || display === "both";
    case "both":
      return display === "both";
  }
}

// upstream/src/host/work-status.ts
function turnEndState(kind) {
  if (kind === "completed") return "success";
  if (kind === "error" || kind === "max-tokens" || kind === "timeout") return "error";
  if (kind === "blocked") return "waiting";
  return null;
}
var USER_QUESTION_TOOL = "ask_user_question";
var GOAL_UPDATE_TOOL = "update_goal";
function goalUpdateAction(args) {
  try {
    const o = JSON.parse(args);
    const action = String(o?.action ?? "");
    if (action === "complete" || action === "blocked") return action;
  } catch {
  }
  return null;
}
function completedState(turn) {
  if (!turn?.goalRound) return "success";
  if (turn.closing === "blocked") return "error";
  if (turn.closing === "complete") return "success";
  return "result";
}
function reduceWorkStatus(event, turn) {
  switch (event?.type) {
    case "turn/start":
      return "thinking";
    case "tool/call": {
      if (String(event?.data?.name ?? "") === USER_QUESTION_TOOL) return "waiting";
      return "working";
    }
    case "tool/result":
      return "result";
    case "approval/asked":
      return "waiting";
    case "turn/end": {
      const reason = turnEndState(String(event?.data?.reason?.kind ?? ""));
      if (reason === "success") return completedState(turn);
      return reason;
    }
    default:
      return null;
  }
}
var TASK_TEXT_MAX = 40;
function currentTaskFromTodo(event) {
  const todos = Array.isArray(event?.data?.todos) ? event.data.todos : [];
  let current;
  for (const t of todos) {
    if (t?.status === "in_progress") current = t;
  }
  if (!current) current = todos.find((t) => t?.status === "pending");
  const content = String(current?.content ?? "").trim();
  if (!content) return null;
  const points = Array.from(content);
  return points.length > TASK_TEXT_MAX ? `${points.slice(0, TASK_TEXT_MAX).join("")}\u2026` : content;
}
var WORK_STATUS_PRIORITY = {
  waiting: 60,
  error: 50,
  working: 40,
  thinking: 30,
  result: 25,
  success: 20
};
function pickDisplayed(entries) {
  let best;
  for (const entry of entries) {
    if (!best || WORK_STATUS_PRIORITY[entry.state] > WORK_STATUS_PRIORITY[best.state] || WORK_STATUS_PRIORITY[entry.state] === WORK_STATUS_PRIORITY[best.state] && entry.seq > best.seq) {
      best = entry;
    }
  }
  return best;
}
var WorkStatusStore = class {
  constructor() {
    this.sessions = /* @__PURE__ */ new Map();
    this.snap = { state: null, task: null, ts: 0 };
  }
  /** 该会话当前是否有活动条目（决定 todo/write 是否还值得更新它的文案） */
  has(sessionId) {
    return this.sessions.has(sessionId);
  }
  /** 该会话当前档位（无条目 / 已清 → undefined） */
  stateOf(sessionId) {
    return this.sessions.get(sessionId)?.state;
  }
  /** 写会话状态（保留该会话已有的 task）；同状态且 seq 不更新 → 无变化返回 false（防刷屏） */
  setState(sessionId, state, seq = 0) {
    const prev = this.sessions.get(sessionId);
    if (prev?.state === state && prev.seq >= seq) return false;
    this.sessions.set(sessionId, { state, seq, task: prev?.task ?? null });
    this.refresh();
    return true;
  }
  /** 写该会话的任务详情（null = 清空）；会话无活动条目 → 不动（它不会被展示） */
  setTask(sessionId, task) {
    const prev = this.sessions.get(sessionId);
    if (!prev || prev.task === task) return false;
    this.sessions.set(sessionId, { ...prev, task });
    this.refresh();
    return true;
  }
  /** 清掉某会话（回合结束 / 终态过期）：它的 task 一并消失，不会残留到后续活动里 */
  clear(sessionId) {
    if (!this.sessions.delete(sessionId)) return false;
    this.refresh();
    return true;
  }
  /** 展示快照（对象引用稳定，供 /work-status 直接序列化） */
  snapshot() {
    return this.snap;
  }
  /** 重算展示：state 与 task **任一**变化才更新 ts（轮询侧据此触发，两端都靠它刷新） */
  refresh() {
    const best = pickDisplayed(this.sessions.values());
    const nextState = best?.state ?? null;
    const nextTask = best?.task ?? null;
    if (nextState === this.snap.state && nextTask === this.snap.task) return;
    this.snap.state = nextState;
    this.snap.task = nextTask;
    this.snap.ts = Date.now();
  }
};

// upstream/src/host/notify-events.ts
function shouldNotifySession(session) {
  const header = session?.header;
  if (!header || typeof header !== "object") return true;
  if (header.origin === "subagent") return false;
  const depth = header.delegationDepth;
  if (typeof depth === "number" && Number.isFinite(depth) && depth > 0) return false;
  return true;
}
function sessionIdOf(session) {
  const s = session;
  return String(s?.header?.id ?? s?.id ?? "unknown");
}
function withSessionId(frame, sessionId) {
  return sessionId === "unknown" ? frame : { ...frame, sessionId };
}
function isCompletionTurnEnd(event) {
  const e = event;
  return e?.type === "turn/end" && e.data?.reason?.kind === "completed";
}
function hasBlockingActivity(activity) {
  if (!Array.isArray(activity)) return false;
  for (const item of activity) {
    const kind = item?.kind;
    if (kind === "job" || kind === "subagent" || kind === "schedule") return true;
  }
  return false;
}
function turnEndNotifyKind(kind) {
  if (kind === "completed") return "completed";
  if (kind === "error" || kind === "max-tokens") return kind;
  return null;
}
var USER_QUESTION_TOOL2 = "ask_user_question";
function parseToolQuestions(args) {
  if (typeof args !== "string") return null;
  try {
    const parsed = JSON.parse(args);
    const questions = parsed?.questions;
    if (!Array.isArray(questions)) return null;
    return questions;
  } catch {
    return null;
  }
}
function reduceNotifyFrame(event) {
  if (!event?.type) return null;
  switch (event.type) {
    case "turn/end": {
      const reason = event.data?.reason;
      const kind = turnEndNotifyKind(reason?.kind);
      if (!kind) return null;
      return {
        type: "session/event",
        event: {
          type: "turn/end",
          data: { reason }
        }
      };
    }
    case "approval/asked": {
      const data = event.data ?? {};
      return {
        type: "approval/requested",
        ...typeof data.toolName === "string" && data.toolName ? { toolName: data.toolName } : {},
        ...typeof data.reason === "string" && data.reason ? { reason: data.reason } : {}
      };
    }
    case "tool/call": {
      if (String(event.data?.name ?? "") !== USER_QUESTION_TOOL2) return null;
      const questions = parseToolQuestions(event.data?.arguments);
      if (!questions || questions.length === 0) return null;
      return { type: "question/requested", questions };
    }
    default:
      return null;
  }
}
function agentErrorFrame(error) {
  const message = typeof error === "string" ? error : error instanceof Error ? error.message : String(error ?? "");
  return { type: "host/agent-error", message };
}

// upstream/src/host/storage-paths.ts
import { existsSync as existsSync4 } from "node:fs";
import { join as join4 } from "node:path";
var DESKTOP_APP_NAME = "dsh-pet-electron-helper";
var ELECTRON_PATHS_NAME = "electron";
function desktopUserDataDir(input) {
  const { home: home2, env = process.env, platform = process.platform } = input;
  if (platform === "win32") return join4(env.APPDATA || join4(home2, "AppData", "Roaming"), DESKTOP_APP_NAME);
  if (platform === "darwin") return join4(home2, "Library", "Application Support", DESKTOP_APP_NAME);
  return join4(env.XDG_CONFIG_HOME || join4(home2, ".config"), DESKTOP_APP_NAME);
}
function electronCacheDir(input) {
  const { home: home2, env = process.env, platform = process.platform } = input;
  if (platform === "win32") {
    return join4(env.LOCALAPPDATA || join4(home2, "AppData", "Local"), ELECTRON_PATHS_NAME, "Cache");
  }
  if (platform === "darwin") return join4(home2, "Library", "Caches", ELECTRON_PATHS_NAME);
  return join4(env.XDG_CACHE_HOME || join4(home2, ".cache"), ELECTRON_PATHS_NAME);
}
function storageEntries(input) {
  const items = [
    { key: "userData", path: input.userDataRoot },
    { key: "electron", path: input.electronDir },
    { key: "desktopCache", path: desktopUserDataDir(input) },
    { key: "electronCache", path: electronCacheDir(input) },
    { key: "package", path: input.packageRoot }
  ];
  return items.map((it) => ({ ...it, exists: existsSync4(it.path) }));
}
function profileNameFrom(packageRoot2) {
  const m = /[\\/]profiles[\\/]([^\\/]+)[\\/]node_modules[\\/][^\\/]+[\\/]?$/.exec(packageRoot2);
  return m?.[1];
}

// upstream/src/host/state.ts
var MAX_STATE_WAIT_MS = 10 * 1e3;
function parseStateWaitQuery(sinceRaw, timeoutRaw) {
  if (sinceRaw === null && timeoutRaw === null) return { kind: "none" };
  if (sinceRaw === null || timeoutRaw === null) {
    return { kind: "error", error: "since and timeout must be used together" };
  }
  if (!/^\d+$/.test(sinceRaw)) return { kind: "error", error: "invalid since (expect a non-negative integer)" };
  if (!/^\d+$/.test(timeoutRaw)) {
    return { kind: "error", error: `invalid timeout (expect 0..${MAX_STATE_WAIT_MS})` };
  }
  const since = Number(sinceRaw);
  const timeoutMs = Number(timeoutRaw);
  if (!Number.isFinite(since)) return { kind: "error", error: "invalid since (expect a non-negative integer)" };
  if (!Number.isFinite(timeoutMs) || timeoutMs > MAX_STATE_WAIT_MS) {
    return { kind: "error", error: `invalid timeout (expect 0..${MAX_STATE_WAIT_MS})` };
  }
  return { kind: "ok", since, timeoutMs };
}
var emptyLeaf = () => ({ counter: 0, data: null });
var PollStateStore = class {
  constructor() {
    this.last = 0;
    this.sections = {
      balance: emptyLeaf(),
      workStatus: emptyLeaf(),
      notify: emptyLeaf(),
      config: emptyLeaf(),
      // 第三方右键菜单项（src/host/menu 的注册表快照）：第三方菜单注册/覆盖时写它，
      // 浏览器与桌面两端据此在右键菜单里拼出「更多」。data 形状见 shared/menu 的 readMenuItems。
      menu: emptyLeaf()
    };
    this.pets = /* @__PURE__ */ new Map();
    this.waiters = /* @__PURE__ */ new Set();
  }
  /** 下一个 counter：`Date.now()` 与「上一个 +1」取大——单调、不回退、同毫秒不重复 */
  next() {
    this.last = Math.max(Date.now(), this.last + 1);
    return this.last;
  }
  /**
   * 写一个全局叶子（余额 / 工作状态 / 通知 / 配置变更信号）。
   * 每次都整体替换叶子对象（不原地改字段），保证 `read()` 拿到的引用不会半新半旧。
   */
  writeSection(name, data) {
    this.sections[name] = { counter: this.next(), data };
    this.wakeWaiters();
  }
  /** 写一只宠物的叶子（宠物条目不存在则自动建立，**所有槽位一起建好**，形状恒定） */
  writePet(petId, leaf, data) {
    let entry = this.pets.get(petId);
    if (!entry) {
      entry = { say: emptyLeaf(), anim: emptyLeaf(), position: emptyLeaf(), throw: emptyLeaf(), lock: emptyLeaf() };
      this.pets.set(petId, entry);
    }
    entry[leaf] = { counter: this.next(), data };
    this.wakeWaiters();
  }
  /**
   * 当前 S（GET /state 的响应体）。
   * 返回的 sections 是浅拷贝、pets 是新建对象——叶子对象本身共享，但写入永远整体替换，
   * 所以消费端不会读到写了一半的叶子。
   */
  read() {
    return { counter: this.last, sections: { ...this.sections }, pets: Object.fromEntries(this.pets) };
  }
  /**
   * 挂起一个等待者：直到 `last` 变得不等于 `since`、或超时、或调用方取消。
   *
   * 三种收尾对调用方是同一件事（去 `read()` 拿最新状态），所以回调不带参数——
   * 需要区分"等到了"还是"超时了"的场景并不存在。
   *
   * **唤醒发生在写入落定之后**（见两个 write 方法里 `wakeWaiters()` 的位置）：如果放在
   * `next()` 里，回调会先于 `this.sections[name] = …` 执行，调用方读到的就是**旧状态**。
   *
   * @returns 取消函数（清掉超时定时器并摘掉等待者）
   */
  wait(args) {
    const waiter = { since: args.since, onWake: args.onWake, timer: void 0 };
    this.waiters.add(waiter);
    waiter.timer = setTimeout(
      () => {
        this.dropWaiter(waiter);
        waiter.onWake();
      },
      Math.max(0, args.timeoutMs)
    );
    if (process.env.NODE_TEST_CONTEXT === void 0) waiter.timer.unref?.();
    return () => this.dropWaiter(waiter);
  }
  /**
   * 结束**所有**挂起的等待（插件卸载 / 宿主退出路径）。
   * 唤醒时不给区分标志：调用方据此立刻收尾，而不是留一个悬挂的响应。
   */
  cancelAll() {
    for (const waiter of [...this.waiters]) {
      this.dropWaiter(waiter);
      waiter.onWake();
    }
  }
  /** 当前等待者数（测试 / 观测用：验证不泄漏） */
  waiterCount() {
    return this.waiters.size;
  }
  /**
   * 唤醒所有**已经过期**的等待者（唯一调用点是两个 write 方法，且必须在叶子写定之后）。
   * `since === this.last` 的跳过：那种等待者是"已经是最新"的，叫醒它等于空转。
   */
  wakeWaiters() {
    if (this.waiters.size === 0) return;
    for (const waiter of [...this.waiters]) {
      if (waiter.since === this.last) continue;
      this.dropWaiter(waiter);
      waiter.onWake();
    }
  }
  /** 摘掉一个等待者（清定时器 + 从集合移除） */
  dropWaiter(waiter) {
    if (waiter.timer !== void 0) {
      clearTimeout(waiter.timer);
      waiter.timer = void 0;
    }
    this.waiters.delete(waiter);
  }
};

// upstream/src/host/time-context.ts
var SLOTS = [
  [23, "\u6DF1\u591C"],
  [19, "\u665A\u4E0A"],
  [17, "\u508D\u665A"],
  [13, "\u4E0B\u5348"],
  [11, "\u4E2D\u5348"],
  [9, "\u4E0A\u5348"],
  [7, "\u65E9\u4E0A"],
  [5, "\u6E05\u6668"],
  [0, "\u51CC\u6668"]
];
var WEEKDAYS = ["\u661F\u671F\u65E5", "\u661F\u671F\u4E00", "\u661F\u671F\u4E8C", "\u661F\u671F\u4E09", "\u661F\u671F\u56DB", "\u661F\u671F\u4E94", "\u661F\u671F\u516D"];
var DAY_MS = 864e5;
var DEFAULT_AHEAD = 3;
var DEFAULT_SPAN = 1;
var DEFAULT_AFTER = 3;
var SEASON_AHEAD = 3;
var SEASON_ENDING_AHEAD = 3;
var SEASON_AFTER = 3;
function pad2(n) {
  return String(n).padStart(2, "0");
}
function timeSlotOf(hour) {
  for (const [start, slot] of SLOTS) {
    if (hour >= start) return slot;
  }
  return "\u51CC\u6668";
}
function dayKindOf(day) {
  return day === 0 || day === 6 ? "\u5468\u672B" : "\u5DE5\u4F5C\u65E5";
}
var PRIORITY = [
  // —— 小节：只有当天值得说，排在邻座之前并掐掉回味 ——
  { kind: "solar", key: "2-14", name: "\u60C5\u4EBA\u8282", after: 0 },
  // 不让春节的 3 天前窗吃掉情人节当天
  { kind: "solar", key: "12-31", name: "\u8DE8\u5E74\u591C", after: 0 },
  // 排在元旦前：12/31 说跨年夜，1/1 说元旦
  { kind: "solar", key: "4-1", name: "\u611A\u4EBA\u8282", after: 0 },
  // 排在清明前，否则 4/1 会说「快要过清明节了」
  { kind: "solar", key: "5-4", name: "\u9752\u5E74\u8282", ahead: 0, after: 0 },
  // 排在劳动节前，否则 5/4 被劳动节回味压掉；不留前后窗，免得抢 5/3 的最后一天
  // —— 春节一族：除夕、元宵必须在春节之前 ——
  // ahead:1 → 2/15 起才预热，免得 2/14 就说「快要过除夕了」；after:0 → 2/17 交给春节当天，不说「除夕刚过完」
  { kind: "lunarEve", name: "\u9664\u5915", ahead: 1, after: 0 },
  { kind: "lunar", key: "1-15", name: "\u5143\u5BB5\u8282" },
  { kind: "lunar", key: "1-1", name: "\u6625\u8282", spoken: "\u5927\u5E74\u521D\u4E00", span: 15 },
  // 正月初一 → 正月十五
  // —— 大节（假期长度按各自实际）——
  { kind: "lunar", key: "8-15", name: "\u4E2D\u79CB\u8282", span: 3, after: 2 },
  // 中秋假期 3 天；小节过去就过去了
  { kind: "solar", key: "10-1", name: "\u56FD\u5E86\u8282", span: 7 },
  // 国庆假期 7 天
  { kind: "solar", key: "1-1", name: "\u5143\u65E6", spoken: "\u65B0\u5E74\u7B2C\u4E00\u5929", span: 3 },
  // 元旦假期 3 天
  { kind: "lunar", key: "5-5", name: "\u7AEF\u5348\u8282", span: 3 },
  { kind: "solar", key: "4-4", name: "\u6E05\u660E\u8282", span: 3, ahead: 1 },
  // 大致 4/4 起 3 天（真日期为节气 4/4 或 4/5）；ahead:1 让出 4/1–4/2 给愚人节
  { kind: "solar", key: "5-1", name: "\u52B3\u52A8\u8282", span: 3 },
  { kind: "solar", key: "6-1", name: "\u513F\u7AE5\u8282" },
  // —— 传统节日：排在寒暑假之前，假期里照常过节 ——
  { kind: "lunar", key: "7-7", name: "\u4E03\u5915" },
  { kind: "lunar", key: "7-15", name: "\u4E2D\u5143\u8282" },
  { kind: "lunar", key: "2-2", name: "\u9F99\u62AC\u5934" },
  { kind: "lunar", key: "9-9", name: "\u91CD\u9633\u8282" },
  { kind: "lunar", key: "12-8", name: "\u814A\u516B\u8282" },
  { kind: "lunar", key: "12-23", name: "\u5C0F\u5E74" },
  // —— 假期区间（大致区间，非校历）——
  { kind: "season", from: "1-20", to: "2-18", name: "\u5BD2\u5047" },
  // 30 天
  { kind: "season", from: "7-1", to: "8-29", name: "\u6691\u5047" },
  // 60 天
  // —— 纪念日类：排在假期之后，假期里让位给假期 ——
  { kind: "solar", key: "3-8", name: "\u5987\u5973\u8282" },
  { kind: "solar", key: "9-10", name: "\u6559\u5E08\u8282" },
  { kind: "solar", key: "7-1", name: "\u5EFA\u515A\u8282" },
  { kind: "solar", key: "8-1", name: "\u5EFA\u519B\u8282" },
  { kind: "solar", key: "10-31", name: "\u4E07\u5723\u591C" },
  // 平安夜排在圣诞节之前（12/24 说平安夜），after:0 让它别用回味吃掉 12/25 的圣诞节当天
  { kind: "solar", key: "12-24", name: "\u5E73\u5B89\u591C", after: 0 },
  { kind: "solar", key: "12-25", name: "\u5723\u8BDE\u8282" }
];
var SOLAR_INDEX = /* @__PURE__ */ new Map();
var LUNAR_INDEX = /* @__PURE__ */ new Map();
var SEASON_ENTRIES = [];
var LUNAR_EVE;
PRIORITY.forEach((entry, priority) => {
  if (entry.kind === "solar") SOLAR_INDEX.set(entry.key, { entry, priority });
  else if (entry.kind === "lunar") LUNAR_INDEX.set(entry.key, { entry, priority });
  else if (entry.kind === "lunarEve") LUNAR_EVE = { entry, priority };
  else SEASON_ENTRIES.push({ entry, priority, from: entry.from, to: entry.to });
});
var lunarFormatter;
function getLunarFormatter() {
  if (lunarFormatter === null) return void 0;
  if (!lunarFormatter) {
    const fmt = new Intl.DateTimeFormat("en-u-ca-chinese", { month: "numeric", day: "numeric", year: "numeric" });
    lunarFormatter = fmt.resolvedOptions().calendar === "chinese" ? fmt : null;
  }
  return lunarFormatter ?? void 0;
}
function dayOfYear(date) {
  return (Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) - Date.UTC(date.getFullYear(), 0, 1)) / DAY_MS;
}
function dayOfYearOf(year, monthDay) {
  const [month, day] = monthDay.split("-").map(Number);
  return (Date.UTC(year, (month ?? 1) - 1, day ?? 1) - Date.UTC(year, 0, 1)) / DAY_MS;
}
function lunarPartsOf(date) {
  const fmt = getLunarFormatter();
  if (!fmt) return void 0;
  const parts = fmt.formatToParts(date);
  const pick = (type) => parts.find((p) => p.type === type)?.value;
  const rawMonth = pick("month");
  const rawDay = pick("day");
  const rawYear = pick("relatedYear") ?? pick("year");
  if (!rawMonth || !rawDay || !rawYear) return void 0;
  const month = Number.parseInt(rawMonth, 10);
  const day = Number.parseInt(rawDay, 10);
  const year = Number.parseInt(rawYear, 10);
  if (!Number.isFinite(month) || !Number.isFinite(day) || !Number.isFinite(year)) return void 0;
  const gregorianYear = date.getFullYear();
  if (year !== gregorianYear && year !== gregorianYear - 1) return void 0;
  return { month: /bis/i.test(rawMonth) ? -month : month, day };
}
function isLunarEve(date) {
  const today = lunarPartsOf(date);
  if (!today || today.month !== 12) return false;
  const next = lunarPartsOf(new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1));
  return Boolean(next && next.month === 1 && next.day === 1);
}
function entriesAt(date) {
  const out = [];
  const solar = SOLAR_INDEX.get(date.getMonth() + 1 + "-" + date.getDate());
  if (solar) out.push(solar);
  const lunar = lunarPartsOf(date);
  if (lunar && lunar.month > 0) {
    const hit = LUNAR_INDEX.get(lunar.month + "-" + lunar.day);
    if (hit) out.push(hit);
  }
  if (LUNAR_EVE && isLunarEve(date)) out.push(LUNAR_EVE);
  return out;
}
function phraseOf(entry, delta) {
  const span = entry.span ?? DEFAULT_SPAN;
  if (delta > 0) return delta === 1 ? "\u660E\u5929\u5C31\u662F" + entry.name : "\u5FEB\u8981\u8FC7" + entry.name + "\u4E86";
  if (delta === 0) return "\u4ECA\u5929\u662F" + (entry.spoken ?? entry.name);
  const daysIn = -delta;
  if (daysIn < span) {
    return span - daysIn === 1 ? entry.name + "\u5047\u671F\u6700\u540E\u4E00\u5929\u4E86" : "\u8FD8\u5728" + entry.name + "\u5047\u671F\u91CC";
  }
  const rest = daysIn - span;
  return rest <= 1 ? entry.name + "\u521A\u8FC7\u5B8C" : entry.name + "\u8FD9\u4E48\u5FEB\u5C31\u8FC7\u5B8C\u4E86";
}
function candidateOf(ranked, delta) {
  const { entry, priority } = ranked;
  const ahead = entry.ahead ?? DEFAULT_AHEAD;
  const span = entry.span ?? DEFAULT_SPAN;
  const after = entry.after ?? DEFAULT_AFTER;
  const daysIn = -delta;
  if (delta > 0) {
    if (delta > ahead) return void 0;
  } else if (delta < 0) {
    if (daysIn >= span + after) return void 0;
  }
  return { clause: phraseOf(entry, delta), priority };
}
function seasonCandidateOf(date) {
  const year = date.getFullYear();
  const today = dayOfYear(date);
  for (const ranked of SEASON_ENTRIES) {
    const { entry, priority, from: fromMd, to: toMd } = ranked;
    const name = entry.name;
    const from = dayOfYearOf(year, fromMd);
    const to = dayOfYearOf(year, toMd);
    if (today < from) {
      const ahead = from - today;
      if (ahead > SEASON_AHEAD) continue;
      return { clause: ahead === 1 ? "\u660E\u5929\u5C31\u653E" + name + "\u4E86" : "\u5FEB\u8981\u653E" + name + "\u4E86", priority };
    }
    if (today <= to) {
      if (today === from) return { clause: name + "\u5F00\u59CB\u4E86", priority };
      if (to - today < SEASON_ENDING_AHEAD) return { clause: name + "\u5FEB\u7ED3\u675F\u4E86", priority };
      return { clause: "\u6B63\u5728\u653E" + name, priority };
    }
    const rest = today - to - 1;
    if (rest >= SEASON_AFTER) continue;
    return { clause: rest <= 1 ? name + "\u521A\u7ED3\u675F" : name + "\u8FD9\u4E48\u5FEB\u5C31\u8FC7\u5B8C\u4E86", priority };
  }
  return void 0;
}
var HOLIDAY_ENTRIES = PRIORITY.filter((e) => e.kind !== "season");
var MAX_AHEAD = Math.max(...HOLIDAY_ENTRIES.map((e) => e.ahead ?? DEFAULT_AHEAD));
var MAX_LOOKBACK = Math.max(...HOLIDAY_ENTRIES.map((e) => (e.span ?? DEFAULT_SPAN) - 1 + (e.after ?? DEFAULT_AFTER)));
function holidayClauseOf(date) {
  let best;
  const keep = (candidate) => {
    if (candidate && (!best || candidate.priority < best.priority)) best = candidate;
  };
  for (let delta = -MAX_LOOKBACK; delta <= MAX_AHEAD; delta++) {
    const day = new Date(date.getFullYear(), date.getMonth(), date.getDate() + delta);
    for (const ranked of entriesAt(day)) keep(candidateOf(ranked, delta));
  }
  keep(seasonCandidateOf(date));
  return best ? best.clause : "";
}
function timeContextOf(date) {
  if (Number.isNaN(date.getTime())) return "";
  const day = date.getDay();
  const hour = date.getHours();
  const holiday = holidayClauseOf(date);
  return "\u3010\u5F53\u4E0B\u3011\u73B0\u5728\u662F" + date.getFullYear() + "\u5E74" + (date.getMonth() + 1) + "\u6708" + date.getDate() + "\u65E5" + (WEEKDAYS[day] ?? "\u661F\u671F?") + " " + pad2(hour) + ":" + pad2(date.getMinutes()) + "\uFF0C" + timeSlotOf(hour) + "\uFF0C" + dayKindOf(day) + (holiday ? "\uFF0C" + holiday : "") + "\u3002\u8FD9\u53EA\u662F\u80CC\u666F\uFF0C\u4E0D\u5FC5\u523B\u610F\u62A5\u65F6\uFF0C\u4E5F\u522B\u53E5\u53E5\u90FD\u63D0\u8282\u65E5\u2014\u2014\u591A\u6570\u65F6\u5019\u6B63\u5E38\u8BF4\u8BDD\u5C31\u597D\uFF0C\u771F\u8D34\u5207\u65F6\u624D\u987A\u53E3\u5E26\u4E00\u53E5\u3002";
}

// upstream/src/host/persona.ts
function petPersona(conf, pet) {
  const own = pet.whisperPrompt;
  if (typeof own === "string" && own.trim() !== "") return own;
  const entry = conf.whisperPrompt;
  return typeof entry === "string" ? entry : "";
}
function composeSystemPrompt(parts) {
  const name = String(parts.name || parts.id);
  const nameLine = name ? "\u4F60\u7684\u540D\u5B57\u662F\u201C" + name + "\u201D\u3002" : "";
  const lines = [parts.prompt, nameLine].filter((line) => line !== "");
  const time = timeContextOf(parts.now);
  if (time) lines.push(time);
  return lines.join("\n");
}

// upstream/src/host/index.ts
var PACKAGE_ROOT = resolve2(fileURLToPath2(new URL("..", import.meta.url)));
var PACKAGE_ROOT_ASSETS = join5(PACKAGE_ROOT, "assets");
var PACKAGE_MEMES_DIR = join5(PACKAGE_ROOT_ASSETS, "memes");
var ROUTE_PREFIX = "/dsh-pet-7340";
var isDesktopHost = () => Boolean(process.versions.electron);
var MIME = {
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".mp4": "video/mp4",
  ".png": "image/png",
  ".json": "application/json; charset=utf-8",
  ".jsonc": "application/json; charset=utf-8",
  ".ttf": "font/ttf",
  ".woff": "font/woff",
  ".woff2": "font/woff2"
};
function resolveAsset(root, rel) {
  if (rel.length === 0) return void 0;
  const candidate = normalize(join5(root, rel));
  const rootWithSep = root.endsWith(sep) ? root : root + sep;
  if (candidate !== root && !candidate.startsWith(rootWithSep)) return void 0;
  return candidate;
}
function resolveExisting(root, rel) {
  const candidate = resolveAsset(root, rel);
  return candidate && existsSync5(candidate) ? candidate : void 0;
}
function sendFile(res, file, contentType) {
  const stream = createReadStream(file);
  stream.once("open", (fd) => {
    if (res.destroyed || res.writableEnded) {
      stream.destroy();
      return;
    }
    try {
      res.writeHead(200, {
        "content-type": contentType,
        "content-length": fstatSync(fd).size,
        "cache-control": "public, max-age=3600"
      });
    } catch {
      res.writeHead(200, { "content-type": contentType, "cache-control": "public, max-age=3600" });
    }
    stream.pipe(res);
  });
  stream.on("error", () => res.destroy());
  res.on("close", () => stream.destroy());
}
var isDesktopVisible = (display) => display === "desktop" || display === "both";
function sendJson(res, status, obj2, headers = {}) {
  const body = JSON.stringify(obj2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    ...headers
  });
  res.end(body);
}
function sendText(res, status, body) {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve22, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve22(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
function apply(ctx) {
  const dshHome = dshHomeDir();
  const userRoot = join5(dshHome, "dsh-pet");
  const userConfigPath = join5(userRoot, "main-config.jsonc");
  const legacyUserConfigPath = join5(userRoot, "main-config.json");
  const petConfigDir = join5(userRoot, "pet");
  const configPaths = {
    defaultFile: join5(PACKAGE_ROOT, "assets", "config.jsonc"),
    userFile: userConfigPath,
    legacyUserFile: legacyUserConfigPath,
    petDir: petConfigDir
  };
  migrateUserConfig(configPaths, (msg) => console.log("[dsh-pet] " + msg));
  const thumbUserRoot = join5(userRoot, "main-animation");
  const memesUserRoot = join5(userRoot, "memes");
  const memeDirsFor = (assetRoot) => {
    const own = resolveAsset(petConfigDir, assetRoot + "-memes");
    if (own !== void 0 && existsSync5(own)) return [own];
    return [memesUserRoot, PACKAGE_MEMES_DIR];
  };
  const state = new PollStateStore();
  const menuRegistry = new MenuRegistry();
  const playback = new PlaybackStore();
  const workStatus = new WorkStatusStore();
  const WORK_STATE_GAP_MS = 5e3;
  const isBusyTier = (s) => s === "working" || s === "result";
  let publishedWork = "\0";
  let publishedState = null;
  let publishedTask = null;
  let publishedWorkAt = 0;
  let workFlushTimer = null;
  const publishWorkStatus = () => {
    const snap = workStatus.snapshot();
    const key = String(snap.state) + "\0" + String(snap.task);
    if (key === publishedWork) return;
    const churn = snap.task === publishedTask && isBusyTier(publishedState) && isBusyTier(snap.state);
    const wait = WORK_STATE_GAP_MS - (Date.now() - publishedWorkAt);
    if (churn && wait > 0) {
      workFlushTimer ??= setTimeout(() => {
        workFlushTimer = null;
        publishWorkStatus();
      }, wait);
      return;
    }
    if (workFlushTimer !== null) {
      clearTimeout(workFlushTimer);
      workFlushTimer = null;
    }
    publishedWork = key;
    publishedState = snap.state;
    publishedTask = snap.task;
    publishedWorkAt = Date.now();
    state.writeSection("workStatus", { state: snap.state, task: snap.task });
  };
  const lock = new LockStore({
    onChange: (petId, data) => state.writePet(petId, "lock", data)
  });
  const pose = new PoseStore();
  const surfaceParam = (params) => {
    const want = normalizeSurface(params.get("surface"));
    if (want !== null) return { ok: true, want };
    return {
      ok: false,
      res: { kind: "json", status: 200, obj: { ok: false, reason: "bad-request", message: SURFACE_TEXT } }
    };
  };
  const surfaceMismatch = (pet, petId, want) => {
    const display = String(pet.display ?? "");
    if (displayCovers(want, display)) return null;
    return {
      kind: "json",
      status: 200,
      obj: {
        ok: false,
        reason: "pet-not-displayed",
        message: petId + " \u7684\u663E\u793A\u6A21\u5F0F\u662F " + display + "\uFF0C\u4E0D\u6EE1\u8DB3 surface=" + want,
        display
      }
    };
  };
  const surfaceBlocked = (cfg, petId, params) => {
    const p = surfaceParam(params);
    if (!p.ok) return p.res;
    return surfaceMismatch(findPetInstance(cfg, petId)?.pet ?? {}, petId, p.want);
  };
  const requirePet = (params, cfg, opts) => {
    const fail2 = (reason, message) => ({
      ok: false,
      res: { kind: "json", status: 200, obj: { ok: false, reason, message } }
    });
    const petId = String(params.get("pet") ?? "").trim();
    if (!petId) return fail2("pet-required", "pet \u5FC5\u586B\uFF1A\u8981\u6307\u5B9A\u64CD\u4F5C\u54EA\u53EA\u684C\u5BA0");
    let want = null;
    if (opts?.surface === true) {
      const p = surfaceParam(params);
      if (!p.ok) return { ok: false, res: p.res };
      want = p.want;
    }
    const found = findPetInstance(cfg(), petId);
    if (!found) return fail2("unknown-pet", "\u6CA1\u6709\u8FD9\u53EA\u684C\u5BA0\uFF1A" + petId);
    if (want !== null) {
      const mismatch = surfaceMismatch(found.pet, petId, want);
      if (mismatch) return { ok: false, res: mismatch };
    }
    return { ok: true, petId, entry: found.entry, conf: found.conf, pet: found.pet };
  };
  const lockBlocked = (petId, params) => {
    const g = lock.gate(petId, String(params.get("lock") ?? ""));
    if (g.ok) return null;
    return {
      kind: "json",
      status: 200,
      obj: g.reason === "lock-lost" ? { ok: false, reason: g.reason, cause: g.cause, message: g.message } : { ok: false, reason: g.reason, message: g.message }
    };
  };
  const pushNotifyFrame = (frame) => {
    state.writeSection("notify", frame);
  };
  const turnFlags = /* @__PURE__ */ new Map();
  const terminalTimers = /* @__PURE__ */ new Map();
  const TERMINAL_KEEP_MS = 60 * 1e3;
  const cancelTerminalCleanup = (sessionId) => {
    const t = terminalTimers.get(sessionId);
    if (t === void 0) return;
    clearTimeout(t);
    terminalTimers.delete(sessionId);
  };
  const scheduleTerminalCleanup = (sessionId) => {
    if (terminalTimers.has(sessionId)) return;
    const t = setTimeout(() => {
      terminalTimers.delete(sessionId);
      const sessionState = workStatus.stateOf(sessionId);
      if (sessionState === "success" || sessionState === "error") {
        workStatus.clear(sessionId);
        turnFlags.delete(sessionId);
        publishWorkStatus();
      }
    }, TERMINAL_KEEP_MS);
    terminalTimers.set(sessionId, t);
  };
  const NOTIFY_ACTIVITY_DELAY_MS = 1500;
  const notifyActivityTimers = /* @__PURE__ */ new Map();
  const sessionHasRunningWork = async (sessionId) => {
    const waterfall = ctx.waterfall;
    if (typeof waterfall !== "function") return false;
    try {
      const activity = await waterfall.call(
        ctx,
        "workspace/session-activity",
        { sessionId },
        () => Promise.resolve([])
      );
      return hasBlockingActivity(activity);
    } catch {
      return false;
    }
  };
  const scheduleCompletionNotify = (sessionId, event) => {
    const prev = notifyActivityTimers.get(sessionId);
    if (prev !== void 0) clearTimeout(prev);
    notifyActivityTimers.set(
      sessionId,
      setTimeout(() => {
        notifyActivityTimers.delete(sessionId);
        void (async () => {
          if (await sessionHasRunningWork(sessionId)) return;
          const frame = reduceNotifyFrame(event);
          if (frame) pushNotifyFrame(withSessionId(frame, sessionId));
        })();
      }, NOTIFY_ACTIVITY_DELAY_MS)
    );
  };
  let activePetId = "";
  const lastWhisperAt = /* @__PURE__ */ new Map();
  const memoryPath = join5(userRoot, "memory.json");
  let chatQueue = Promise.resolve();
  const readMemory = async () => {
    let raw;
    try {
      raw = await readFile(memoryPath, "utf8");
    } catch {
      return {};
    }
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") throw new Error("not an object");
      return parsed;
    } catch (e) {
      console.error(
        `dsh-pet: \u8BB0\u5FC6\u6587\u4EF6\u635F\u574F\u5DF2\u5907\u4EFD\uFF08\u5BF9\u8BDD\u5C06\u4ECE\u5934\u5F00\u59CB\uFF09\uFF1A${memoryPath}\uFF08${e instanceof Error ? e.message : String(e)}\uFF09`
      );
      try {
        await mkdir(userRoot, { recursive: true });
        await writeFile(`${memoryPath}.bak-${Date.now()}`, raw, "utf8");
      } catch {
      }
      return {};
    }
  };
  const writeMemory = async (mem) => {
    await mkdir(userRoot, { recursive: true });
    await writeFile(memoryPath, JSON.stringify(mem, null, 2), "utf8");
  };
  const withMemoryLock = (fn) => {
    const run = chatQueue.then(fn, fn);
    chatQueue = run.then(
      () => void 0,
      () => void 0
    );
    return run;
  };
  const petSystemPrompt = (found) => composeSystemPrompt({
    prompt: petPersona(found.conf, found.pet),
    name: String(found.pet.name ?? ""),
    id: String(found.pet.id ?? ""),
    now: /* @__PURE__ */ new Date()
  });
  const memoryRounds = (conf) => {
    const v = Number(conf.chatMemoryRounds);
    return Number.isFinite(v) && v >= 0 ? Math.floor(v) : 5;
  };
  const publishWhisper = async (petId) => {
    const cfg = readAllConfig(configPaths);
    const found = findPetInstance(cfg, petId);
    if (!found) return { ok: false, reason: "unknown-pet", message: "\u6CA1\u6709\u8FD9\u53EA\u684C\u5BA0\uFF1A" + petId };
    const system = petSystemPrompt(found);
    const meme = found.conf.whisperImageEnabled === true ? pickMeme(readMemePool(found.conf.memes, memeDirsFor(found.entry))) : void 0;
    const result = await generateWhisper(ctx, system, meme, configuredModel(found.conf, "whisperModel"));
    if (!result.ok) {
      console.warn(
        "[dsh-pet] \u788E\u788E\u5FF5\u751F\u6210\u5931\u8D25 pet=" + petId + " reason=" + result.reason + (result.message ? " " + result.message : "")
      );
      return result;
    }
    state.writePet(petId, "say", result.image ? { text: result.text, image: result.image } : { text: result.text });
    return { ok: true, text: result.text, ...result.image ? { image: result.image } : {} };
  };
  const chatWithPet = async (petId, text) => withMemoryLock(async () => {
    const cfg = readAllConfig(configPaths);
    const found = findPetInstance(cfg, petId);
    if (!found) return { ok: false, reason: "unknown-pet", message: "\u6CA1\u6709\u8FD9\u53EA\u684C\u5BA0\uFF1A" + petId };
    const rounds = memoryRounds(found.conf);
    const system = petSystemPrompt(found);
    const pool = found.conf.chatImageEnabled === true ? limitPool(readMemePool(found.conf.memes, memeDirsFor(found.entry)), Number(found.conf.chatImageLimit)) : [];
    const mem = await readMemory();
    const bucket = mem[found.entry] ??= {};
    const entry = bucket[petId] ??= { messages: [] };
    const list = sliceMemoryRounds(entry.messages, rounds);
    const generated = await generateChat(ctx, system, list, text, pool, configuredModel(found.conf, "chatModel"));
    if (!generated.ok) return generated;
    const now = Date.now();
    entry.messages.push({ role: "user", content: text, ts: now });
    entry.messages.push({ role: "assistant", content: generated.text, ts: now });
    await writeMemory(mem);
    state.writePet(
      petId,
      "say",
      generated.image ? { text: generated.text, image: generated.image } : { text: generated.text }
    );
    return { ok: true, text: generated.text, ...generated.image ? { image: generated.image } : {} };
  });
  const effectivePetList = () => flattenPetList(readAllConfig(configPaths));
  const balancePeriodSec = (cfg) => {
    const ers = cfg.main?.eventsRefreshSec;
    const n = Number(ers?.balance);
    return Number.isFinite(n) && n > 0 ? n : 1800;
  };
  const whisperPeriodSec = (conf) => {
    const ers = conf.eventsRefreshSec;
    const n = Number(ers?.whisper);
    return Number.isFinite(n) && n > 0 ? n : 300;
  };
  const accountClientMetadata = () => {
    let version = "0.0.0";
    try {
      const raw = JSON.parse(readFileSync2(join5(PACKAGE_ROOT, "package.json"), "utf8"));
      if (typeof raw.version === "string" && raw.version.length > 0) version = raw.version;
    } catch {
    }
    return { version, locale: "zh-CN", timezoneOffsetSeconds: -(/* @__PURE__ */ new Date()).getTimezoneOffset() * 60 };
  };
  const refreshBalance = async (manual = false) => {
    const mark = (v) => manual ? { ...v, manual: true } : v;
    try {
      const sel = ctx.agentDefaultModel.currentSelection();
      const result = await queryBalance(
        sel.provider,
        async (ref) => {
          const rc = await ctx.credentials.resolve(credentialRef(ref));
          return rc?.value;
        },
        // `deepseek-account`（免费额度 / 平台登录）没有 API Key：它的凭证是 DSH 账号服务
        // 持有的授权记录，只能经 getBalance 查询。账号服务是**可选**服务（软取，不放进
        // inject）——没装账号插件时它不在场，此时该路由报 credential-missing 而不是崩。
        async () => {
          const account = ctx.get("deepseekAccount", false);
          if (!account) return void 0;
          return account.getBalance(accountClientMetadata());
        }
      );
      state.writeSection("balance", mark(result));
    } catch (e) {
      state.writeSection(
        "balance",
        mark({
          ok: false,
          provider: "unknown",
          reason: "fetch-error",
          message: e instanceof Error ? e.message : String(e)
        })
      );
    }
  };
  const resolveActivePetId = () => {
    try {
      const eff = effectivePetList();
      if (eff.length === 0) return "";
      if (activePetId && eff.some((p) => String(p.id) === activePetId)) return activePetId;
      return String(eff[0].id);
    } catch {
      return activePetId;
    }
  };
  const petDisplayName = (pet) => {
    const n = String(pet.name ?? "").trim();
    return n || String(pet.id ?? "");
  };
  let hasDesktopPet = false;
  let desktopModeEverActive = false;
  const refreshDesktop = () => {
    hasDesktopPet = false;
    try {
      hasDesktopPet = effectivePetList().some((p) => isDesktopVisible(p.display));
    } catch (e) {
      ctx.logger?.warn?.(`[dsh-pet] \u5BA0\u7269\u914D\u7F6E\u975E\u6CD5\uFF0C\u684C\u9762\u6A21\u5F0F\u5DF2\u8DF3\u8FC7\uFF1A${e instanceof Error ? e.message : String(e)}`);
    }
  };
  refreshDesktop();
  const desktopPetList = () => {
    try {
      return effectivePetList().filter((p) => isDesktopVisible(p.display)).map((p) => ({ id: String(p.id), size: Number(p.size) }));
    } catch {
      return [];
    }
  };
  let helper;
  let startRetryTimer;
  let electronEnsure;
  let disposed = false;
  let displayWarned = false;
  const launchHelper = (electronPath) => {
    if (helper || disposed) return;
    if (!hasDesktopPet && !desktopModeEverActive) return;
    const port2 = typeof ctx.webServer?.port === "number" ? ctx.webServer.port : 0;
    if (!port2 || port2 <= 0) {
      if (!startRetryTimer) {
        startRetryTimer = setTimeout(() => {
          startRetryTimer = void 0;
          launchHelper(electronPath);
        }, 500);
        startRetryTimer.unref?.();
      }
      return;
    }
    const origin = `http://127.0.0.1:${port2}`;
    const siteUrl = ctx.connection.authenticatedUrl(origin);
    const configUrl = `${origin}${ROUTE_PREFIX}/config`;
    helper = new HelperProcess(
      {
        electronPath,
        env: {
          DSH_PET_CONFIG_URL: configUrl,
          // 已鉴权站点 URL（含本进程启动令牌）：只供 helper 的「打开网站」使用，任何日志都不许出现它
          DSH_PET_SITE_URL: siteUrl,
          // 宿主形态决定工具项「打开网站」的去向（同名菜单项，两端两种语义）：
          //   desktop = 宿主是 DSH 桌面应用 → 唤起桌面应用主窗口（helper 走 dsh://open，见 main.js）
          //   site    = dsh web / 独立模式 → 系统默认浏览器打开站点（原行为，别破坏）
          DSH_PET_OPEN_TARGET: isDesktopHost() ? "desktop" : "site",
          DSH_PET_SCALE: "1",
          // 打开 bridge 协议：main.js 注册 dsh-pet-bridge scheme，把渲染端请求经管道转给宿主
          DSH_PET_BRIDGE: "1",
          // 每只桌面宠物一个局部小窗口：透传宠物列表（[{id,size}]）
          DSH_PET_PETS: JSON.stringify(desktopPetList())
        },
        // bridge 协议处理器 = HTTP 路由同一份 handlePetRoute（业务逻辑唯一，两端天然一致）；
        // 素材过文件路径（main.js 自行读盘），json/text 过 body
        bridgeHandler: async (req) => {
          const result = await handlePetRoute(req.url ?? "/", req.method ?? "GET", req.body);
          if (result.kind === "file") {
            return { id: req.id, status: 200, contentType: result.contentType, file: result.file };
          }
          if (result.kind === "text") {
            return { id: req.id, status: result.status, contentType: "text/plain; charset=utf-8", body: result.body };
          }
          if (result.kind === "none") {
            return { id: req.id, status: 204, contentType: "text/plain; charset=utf-8", body: "" };
          }
          return {
            id: req.id,
            status: result.status,
            contentType: "application/json; charset=utf-8",
            body: JSON.stringify(result.obj)
          };
        }
      },
      ctx.logger ?? console
    );
    try {
      helper.start();
      desktopModeEverActive = true;
      ctx.logger?.info?.(`dsh-pet desktop helper started (config: ${configUrl})`);
    } catch (e) {
      ctx.logger?.warn?.(`dsh-pet desktop helper start failed: ${e instanceof Error ? e.message : String(e)}`);
      helper = void 0;
    }
  };
  const startHelper = () => {
    if (helper || electronEnsure || disposed) return;
    if (!hasDesktopPet && !desktopModeEverActive) return;
    if (!hasGraphicalDisplay()) {
      if (!displayWarned) {
        displayWarned = true;
        ctx.logger?.warn?.(
          "[dsh-pet] \u672A\u68C0\u6D4B\u5230\u56FE\u5F62\u663E\u793A\u73AF\u5883\uFF08DISPLAY/WAYLAND_DISPLAY \u5747\u4E3A\u7A7A\uFF09\uFF0C\u5DF2\u8DF3\u8FC7\u684C\u9762\u5BA0\u7269\u3002\u6D4F\u89C8\u5668\u5185\u5BA0\u7269\u4E0D\u53D7\u5F71\u54CD\uFF1B\u5982\u9700\u5728\u670D\u52A1\u5668\u4E0A\u542F\u7528\u684C\u9762\u6A21\u5F0F\uFF0C\u8BF7\u914D\u7F6E Xvfb \u540E\u8BBE\u7F6E DSH_PET_DESKTOP_FORCE=1\u3002"
        );
      }
      return;
    }
    const found = resolveElectronPath();
    if (found) {
      launchHelper(found);
      return;
    }
    console.warn(`[dsh-pet] Electron not found, downloading to ${defaultElectronExe()} ...`);
    electronEnsure = ensureElectronDownload().then((path) => {
      if (path) {
        launchHelper(path);
      } else {
        console.warn(
          "[dsh-pet] Electron download failed; desktop pet unavailable. Set DSH_PET_ELECTRON_PATH and restart, or retry later."
        );
      }
    }).finally(() => {
      electronEnsure = void 0;
    });
  };
  const stopHelper = (reason = "settings-change") => {
    if (startRetryTimer) {
      clearTimeout(startRetryTimer);
      startRetryTimer = void 0;
    }
    helper?.stop(reason);
    helper = void 0;
  };
  const stopHelperAndWait = async (reason) => {
    if (startRetryTimer) {
      clearTimeout(startRetryTimer);
      startRetryTimer = void 0;
    }
    const old = helper;
    helper = void 0;
    await old?.stopAndWait(reason);
  };
  let desktopSyncQueue = Promise.resolve();
  const syncDesktop = () => {
    desktopSyncQueue = desktopSyncQueue.then(async () => {
      refreshDesktop();
      await stopHelperAndWait("desktop-config-change");
      startHelper();
    }).catch((e) => {
      ctx.logger?.warn?.(`[dsh-pet] \u91CD\u542F\u684C\u9762 Helper \u5931\u8D25\uFF1A${e instanceof Error ? e.message : String(e)}`);
    });
    return desktopSyncQueue;
  };
  const animSubdirFor = (ext) => ext === ".mov" ? "mov" : "webm";
  const assetRootFor = (ext) => join5(PACKAGE_ROOT, "assets", animSubdirFor(ext));
  const userRootFor = (ext) => join5(thumbUserRoot, animSubdirFor(ext));
  const handlePetRoute = async (rawUrl, method, body, signal) => {
    const url = new URL(rawUrl, "http://localhost");
    const rest = decodeURIComponent(url.pathname.slice(ROUTE_PREFIX.length + 1));
    if (rest === "melo-skin") {
      if (method !== "POST") return { kind: "json", status: 405, obj: { error: "method not allowed" } };
      try {
        const payload = JSON.parse(body || "{}");
        if (!["main", "winter"].includes(payload.skin) || !ctx.meloSelectSkin) {
          return { kind: "json", status: 400, obj: { ok: false, error: "\u672A\u77E5\u76AE\u80A4" } };
        }
        const result = ctx.meloSelectSkin(payload.skin);
        state.writeSection("config", {});
        void syncDesktop();
        return { kind: "json", status: 200, obj: { ok: true, skin: result.skin } };
      } catch (error) {
        return { kind: "json", status: 500, obj: { ok: false, error: error instanceof Error ? error.message : String(error) } };
      }
    }
    if (rest === "config") {
      if (method === "GET") {
        try {
          return {
            kind: "json",
            status: 200,
            obj: readAllConfig(configPaths),
            headers: { "cache-control": "no-cache, no-store" }
          };
        } catch (e) {
          return { kind: "json", status: 500, obj: { error: e instanceof Error ? e.message : String(e) } };
        }
      }
      if (method === "PUT") {
        try {
          const parsed = JSON.parse(body ?? "");
          const existing = readUserConfig(configPaths);
          const clean = saveUserConfig(parsed, existing);
          if (!clean) {
            return {
              kind: "json",
              status: 400,
              obj: {
                error: "invalid pet config: expected { pets:[{name?,id,size,balanceEnabled,display,position:{corner,marginX,marginY}}] }\uFF08display \u4E3A web/desktop/both/none \u4E4B\u4E00\uFF1B\u53EF\u9009\u9876\u5C42 notificationsEnabled / whisperImageEnabled / chatImageEnabled \u5E03\u5C14\uFF1B\u53EF\u9009\u5BA0\u7269\u5E03\u5C14 whisperEnabled / workStatusEnabled / fixedEnabled\uFF09"
              }
            };
          }
          if (url.searchParams.get("force") !== "1" && userConfigUnparsable(configPaths)) {
            return {
              kind: "json",
              status: 409,
              obj: { error: "user config is unparsable", needConfirm: true, userFile: userConfigPath }
            };
          }
          await mkdir(userRoot, { recursive: true });
          await writeFile(userConfigPath, JSON.stringify(clean, null, 2), "utf8");
          void syncDesktop();
          return { kind: "json", status: 200, obj: readAllConfig(configPaths) };
        } catch {
          return { kind: "json", status: 400, obj: { error: "invalid JSON body" } };
        }
      }
      if (method === "POST") {
        try {
          syncUserConfigFromDefault(configPaths);
        } catch (e) {
          return { kind: "json", status: 500, obj: { error: e instanceof Error ? e.message : String(e) } };
        }
        void syncDesktop();
        return { kind: "json", status: 200, obj: readAllConfig(configPaths) };
      }
      return { kind: "json", status: 405, obj: { error: "method not allowed" } };
    }
    if (rest === "pet-display") {
      if (method !== "POST") return { kind: "json", status: 405, obj: { error: "method not allowed" } };
      const fail2 = (reason, message) => ({
        kind: "json",
        status: 200,
        obj: { ok: false, reason, message }
      });
      let payload;
      try {
        payload = JSON.parse(body ?? "");
      } catch {
        return { kind: "json", status: 400, obj: { error: "invalid JSON body" } };
      }
      const petId2 = typeof payload.id === "string" ? payload.id.trim() : "";
      const nextDisplay = String(payload.display ?? "");
      if (!petId2) return fail2("pet-required", "pet \u5FC5\u586B\uFF1A\u8981\u6307\u5B9A\u64CD\u4F5C\u54EA\u53EA\u684C\u5BA0");
      if (!PET_DISPLAY_SET.has(nextDisplay)) {
        return fail2("bad-request", `display \u5FC5\u987B\u662F web / desktop / both / none\uFF1A${nextDisplay}`);
      }
      let merged;
      try {
        merged = readAllConfig(configPaths);
      } catch (e) {
        return fail2("generate-error", e instanceof Error ? e.message : String(e));
      }
      const hit = findPetInstance(merged, petId2);
      if (!hit) return fail2("unknown-pet", `\u6CA1\u6709\u8FD9\u53EA\u684C\u5BA0\uFF1A${petId2}`);
      let layerPath;
      let layerDir;
      let existing;
      if (hit.entry === "main") {
        layerPath = userConfigPath;
        layerDir = userRoot;
        existing = readUserConfig(configPaths);
      } else {
        const file2 = readPetConfigEntry(configPaths, hit.entry);
        if (!file2) {
          return fail2("generate-error", `\u5BA0\u7269\u6761\u76EE\u914D\u7F6E\u6587\u4EF6\u627E\u4E0D\u5230\uFF1A${hit.entry}`);
        }
        layerPath = file2.path;
        layerDir = petConfigDir;
        existing = file2.raw;
      }
      const layerPets = Array.isArray(hit.conf.pets) ? hit.conf.pets : [];
      const pets = layerPets.map((p) => String(p.id) === petId2 ? { ...p, display: nextDisplay } : p);
      const clean = saveUserConfig({ pets }, existing);
      if (!clean) return fail2("bad-request", "\u5BA0\u7269\u914D\u7F6E\u975E\u6CD5");
      try {
        await mkdir(layerDir, { recursive: true });
        await writeFile(layerPath, JSON.stringify(clean, null, 2), "utf8");
      } catch (e) {
        return fail2("generate-error", e instanceof Error ? e.message : String(e));
      }
      state.writeSection("config", {});
      if (nextDisplay === "none") lock.release({ petId: petId2, force: true });
      void syncDesktop();
      return { kind: "json", status: 200, obj: readAllConfig(configPaths) };
    }
    if (rest === "reload") {
      if (method !== "POST") return { kind: "json", status: 405, obj: { error: "method not allowed" } };
      void syncDesktop();
      return { kind: "json", status: 200, obj: { reloading: true } };
    }
    if (rest === "config/meta") {
      return {
        kind: "json",
        status: 200,
        obj: {
          user: userConfigPath,
          default: join5(PACKAGE_ROOT, "assets", "config.jsonc"),
          animations: thumbUserRoot,
          memes: memesUserRoot,
          // 全部落盘位置（本包用户数据 / Electron 运行时 / 桌面端缓存 / 下载缓存 / 插件本体）：
          // 前两条直接传真实写入方的路径，不在这里重拼目录名
          storage: storageEntries({
            userDataRoot: userRoot,
            electronDir: electronLandingDir(),
            home: homedir(),
            packageRoot: PACKAGE_ROOT
          }),
          // profile 名（拼卸载命令 dsh plugin --profile <名> remove dsh-pet；反推不出时为空串）
          profile: profileNameFrom(PACKAGE_ROOT) ?? ""
        }
      };
    }
    if (rest === "menu/item") {
      if (method === "DELETE") {
        const result2 = menuRegistry.clear(url.searchParams.get("owner") ?? "");
        if (!result2.ok) {
          return { kind: "json", status: 200, obj: { ok: false, reason: result2.reason, message: result2.message } };
        }
        state.writeSection("menu", { items: menuRegistry.snapshot() });
        return { kind: "json", status: 200, obj: { ok: true, removed: result2.removed } };
      }
      if (method !== "POST") return { kind: "json", status: 405, obj: { error: "method not allowed" } };
      let parsed;
      try {
        parsed = JSON.parse(body ?? "");
      } catch {
        return { kind: "json", status: 400, obj: { error: "invalid JSON body" } };
      }
      const result = menuRegistry.register(parsed);
      if (!result.ok) {
        return { kind: "json", status: 200, obj: { ok: false, reason: result.reason, message: result.message } };
      }
      state.writeSection("menu", { items: menuRegistry.snapshot() });
      return { kind: "json", status: 200, obj: { ok: true } };
    }
    if (rest === "menu/events") {
      if (method !== "GET") return { kind: "json", status: 405, obj: { error: "method not allowed" } };
      const owner = url.searchParams.get("owner") ?? "";
      const rawWait = Number(url.searchParams.get("wait") ?? "0");
      const waitMs = Number.isFinite(rawWait) && rawWait > 0 ? Math.min(rawWait, MENU_WAIT_MAX_MS) : 0;
      const events = await menuRegistry.poll(owner, waitMs);
      if (events === null) {
        return {
          kind: "json",
          status: 200,
          obj: { ok: false, reason: "unknown-owner", message: "\u8FD9\u4E2A owner \u6CA1\u6709\u6CE8\u518C\uFF0C\u91CD\u65B0\u6CE8\u518C\u5373\u53EF" }
        };
      }
      return { kind: "json", status: 200, obj: { ok: true, events } };
    }
    if (rest === "menu/click") {
      if (method !== "POST") return { kind: "json", status: 405, obj: { error: "method not allowed" } };
      let parsed;
      try {
        parsed = JSON.parse(body ?? "");
      } catch {
        return { kind: "json", status: 400, obj: { error: "invalid JSON body" } };
      }
      return { kind: "json", status: 200, obj: menuRegistry.click(parsed) };
    }
    if (rest === "models") {
      if (method !== "GET") return { kind: "json", status: 405, obj: { error: "method not allowed" } };
      try {
        const llm = ctx.llm;
        const named = (id, name) => {
          const pid = String(id ?? "");
          return { id: pid, name: String(name ?? "") || pid };
        };
        let providers = (typeof llm?.listProviders === "function" ? llm.listProviders() : []).map(
          (p) => named(p?.id, p?.name)
        );
        if (providers.length === 0 && typeof llm?.listConfigurableProviders === "function") {
          providers = llm.listConfigurableProviders().map((p) => named(p?.provider, p?.displayName));
        }
        providers = providers.filter((p) => p.id);
        const catalog = await Promise.all(
          providers.map(async (p) => {
            let models = [];
            try {
              const list = await llm?.listModels?.(p.id);
              models = (Array.isArray(list) ? list : []).map((m) => named(m?.id, m?.name)).filter((m) => m.id);
            } catch {
            }
            return { ...p, models };
          })
        );
        return { kind: "json", status: 200, obj: { providers: catalog } };
      } catch (e) {
        return { kind: "json", status: 500, obj: { error: e instanceof Error ? e.message : String(e) } };
      }
    }
    if (rest === "state") {
      if (method !== "GET") return { kind: "json", status: 405, obj: { error: "method not allowed" } };
      const headers = { "cache-control": "no-cache, no-store" };
      const parsed = parseStateWaitQuery(url.searchParams.get("since"), url.searchParams.get("timeout"));
      if (parsed.kind === "error") return { kind: "json", status: 400, obj: { error: parsed.error } };
      const current = state.read();
      if (parsed.kind === "none" || current.counter !== parsed.since) {
        return { kind: "json", status: 200, obj: current, headers };
      }
      const since = parsed.since;
      return await new Promise((resolveWait) => {
        let settled = false;
        const settle = (result) => {
          if (settled) return;
          settled = true;
          resolveWait(result);
        };
        const cancel = state.wait({
          since,
          timeoutMs: parsed.timeoutMs,
          onWake: () => settle({ kind: "json", status: 200, obj: state.read(), headers })
        });
        const onAbort = () => {
          cancel();
          settle({ kind: "none" });
        };
        if (signal?.aborted) {
          onAbort();
          return;
        }
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    }
    if (rest === "balance") {
      if (method !== "POST") return { kind: "json", status: 405, obj: { error: "method not allowed" } };
      await refreshBalance(true);
      return { kind: "json", status: 200, obj: { ok: true } };
    }
    if (rest === "lock" || rest === "lock/release") {
      const isRelease = rest === "lock/release";
      if (method !== "POST") return { kind: "json", status: 405, obj: { error: "method not allowed" } };
      let parsed;
      try {
        parsed = JSON.parse(body ?? "null");
      } catch {
        return { kind: "json", status: 400, obj: { error: "invalid JSON body" } };
      }
      const o = parsed && typeof parsed === "object" ? parsed : {};
      try {
        const who = requirePet(url.searchParams, () => readAllConfig(configPaths), { surface: !isRelease });
        if (!who.ok) return who.res;
        const petId2 = who.petId;
        if (isRelease) {
          const d2 = lock.release({ petId: petId2, lockId: o.lockId, force: o.force });
          if (!d2.ok) {
            const obj2 = { ok: false, reason: d2.reason, message: d2.message };
            if (d2.reason === "lock-lost") obj2.cause = d2.cause;
            return { kind: "json", status: 200, obj: obj2 };
          }
          return { kind: "json", status: 200, obj: { ok: true } };
        }
        const d = lock.acquire({ petId: petId2, lockId: o.lockId, ttl: o.ttl });
        if (!d.ok) {
          const obj2 = { ok: false, reason: d.reason, message: d.message };
          if (d.reason === "locked") obj2.expiresAt = d.expiresAt;
          if (d.reason === "lock-lost") obj2.cause = d.cause;
          return { kind: "json", status: 200, obj: obj2 };
        }
        return {
          kind: "json",
          status: 200,
          obj: { ok: true, lockId: d.lockId, petId: d.petId, expiresAt: d.expiresAt }
        };
      } catch (e) {
        return {
          kind: "json",
          status: 200,
          obj: { ok: false, reason: "generate-error", message: e instanceof Error ? e.message : String(e) }
        };
      }
    }
    if (rest === "whisper") {
      if (method !== "POST") return { kind: "json", status: 405, obj: { error: "method not allowed" } };
      try {
        const who = requirePet(url.searchParams, () => readAllConfig(configPaths), { surface: true });
        if (!who.ok) return who.res;
        const r = await publishWhisper(who.petId);
        if (r.ok) {
          return {
            kind: "json",
            status: 200,
            obj: { ok: true, text: r.text, ...r.image ? { image: r.image } : {} }
          };
        }
        const obj2 = { ok: false, reason: r.reason };
        if (r.message) obj2.message = r.message;
        return { kind: "json", status: 200, obj: obj2 };
      } catch (e) {
        return {
          kind: "json",
          status: 200,
          obj: { ok: false, reason: "generate-error", message: e instanceof Error ? e.message : String(e) }
        };
      }
    }
    if (rest === "broadcast") {
      if (method !== "POST") return { kind: "json", status: 405, obj: { error: "method not allowed" } };
      let parsed;
      try {
        parsed = JSON.parse(body ?? "null");
      } catch {
        return { kind: "json", status: 400, obj: { error: "invalid JSON body" } };
      }
      const o = parsed && typeof parsed === "object" ? parsed : {};
      if (!normalizeBroadcastText(o.text)) {
        return { kind: "json", status: 200, obj: { ok: false, reason: "bad-request", message: "text \u4E3A\u7A7A" } };
      }
      const duration = normalizeBroadcastDuration(o.duration);
      if (duration === null) {
        return {
          kind: "json",
          status: 200,
          obj: { ok: false, reason: "bad-request", message: "duration \u5FC5\u987B\u662F \u22650 \u7684\u6709\u9650\u6570\u5B57\uFF08\u6BEB\u79D2\uFF09" }
        };
      }
      const anim = normalizeBroadcastAnim(o.anim);
      try {
        const cfg = readAllConfig(configPaths);
        const d = decideBroadcast({
          cfg,
          requested: String(url.searchParams.get("pet") ?? ""),
          text: o.text,
          image: o.image,
          url: o.url,
          duration,
          anim,
          memeDirs: memeDirsFor
        });
        if (!d.ok) return { kind: "json", status: 200, obj: { ok: false, reason: d.reason, message: d.message } };
        const noSurface = surfaceBlocked(cfg, d.petId, url.searchParams);
        if (noSurface) return noSurface;
        const blocked = lockBlocked(d.petId, url.searchParams);
        if (blocked) return blocked;
        const pic = d.url !== void 0 ? { url: d.url } : d.image !== void 0 ? { image: d.image } : {};
        state.writePet(d.petId, "say", { text: d.text, ...pic, duration: d.duration, anim: d.anim });
        return { kind: "json", status: 200, obj: { ok: true } };
      } catch (e) {
        return {
          kind: "json",
          status: 200,
          obj: { ok: false, reason: "generate-error", message: e instanceof Error ? e.message : String(e) }
        };
      }
    }
    if (rest === "bubble/clear") {
      if (method !== "POST") return { kind: "json", status: 405, obj: { error: "method not allowed" } };
      try {
        const cfg = readAllConfig(configPaths);
        const d = decideBubbleClear({
          cfg,
          requested: String(url.searchParams.get("pet") ?? "")
        });
        if (!d.ok) return { kind: "json", status: 200, obj: { ok: false, reason: d.reason, message: d.message } };
        const noSurface = surfaceBlocked(cfg, d.petId, url.searchParams);
        if (noSurface) return noSurface;
        const blocked = lockBlocked(d.petId, url.searchParams);
        if (blocked) return blocked;
        state.writePet(d.petId, "say", { clear: true });
        return { kind: "json", status: 200, obj: { ok: true } };
      } catch (e) {
        return {
          kind: "json",
          status: 200,
          obj: { ok: false, reason: "generate-error", message: e instanceof Error ? e.message : String(e) }
        };
      }
    }
    if (rest === "anim") {
      if (method !== "POST") return { kind: "json", status: 405, obj: { error: "method not allowed" } };
      let parsed;
      try {
        parsed = JSON.parse(body ?? "null");
      } catch {
        return { kind: "json", status: 400, obj: { error: "invalid JSON body" } };
      }
      const o = parsed && typeof parsed === "object" ? parsed : {};
      try {
        const cfg = readAllConfig(configPaths);
        const d = decideAnim({
          cfg,
          requested: String(url.searchParams.get("pet") ?? ""),
          name: o.name,
          url: o.url,
          facing: o.facing
        });
        if (!d.ok) return { kind: "json", status: 200, obj: { ok: false, reason: d.reason, message: d.message } };
        const noSurface = surfaceBlocked(cfg, d.petId, url.searchParams);
        if (noSurface) return noSurface;
        const blocked = lockBlocked(d.petId, url.searchParams);
        if (blocked) return blocked;
        const record = playback.create(d.petId, d.url ?? d.name ?? "");
        state.writePet(d.petId, "anim", {
          ...d.url !== void 0 ? { url: d.url } : { name: d.name },
          playbackId: record.playbackId,
          ...d.facing === void 0 ? {} : { facing: d.facing }
        });
        return { kind: "json", status: 200, obj: { ok: true, playbackId: record.playbackId } };
      } catch (e) {
        return {
          kind: "json",
          status: 200,
          obj: { ok: false, reason: "generate-error", message: e instanceof Error ? e.message : String(e) }
        };
      }
    }
    if (rest === "position" || rest === "throw") {
      const isPosition = rest === "position";
      if (method !== "POST") return { kind: "json", status: 405, obj: { error: "method not allowed" } };
      let parsed;
      try {
        parsed = JSON.parse(body ?? "null");
      } catch {
        return { kind: "json", status: 400, obj: { error: "invalid JSON body" } };
      }
      const o = parsed && typeof parsed === "object" ? parsed : {};
      try {
        const cfg = readAllConfig(configPaths);
        const requested = String(url.searchParams.get("pet") ?? "");
        if (isPosition) {
          const d2 = decidePosition({
            cfg,
            requested,
            x: o.x,
            y: o.y,
            mode: o.mode,
            duration: o.duration
          });
          if (!d2.ok) return { kind: "json", status: 200, obj: { ok: false, reason: d2.reason, message: d2.message } };
          const noSurface2 = surfaceBlocked(cfg, d2.petId, url.searchParams);
          if (noSurface2) return noSurface2;
          const blocked2 = lockBlocked(d2.petId, url.searchParams);
          if (blocked2) return blocked2;
          state.writePet(d2.petId, "position", positionLeafData(d2));
          return { kind: "json", status: 200, obj: { ok: true, x: d2.x, y: d2.y } };
        }
        const d = decideThrow({ cfg, requested, angle: o.angle, power: o.power });
        if (!d.ok) return { kind: "json", status: 200, obj: { ok: false, reason: d.reason, message: d.message } };
        const noSurface = surfaceBlocked(cfg, d.petId, url.searchParams);
        if (noSurface) return noSurface;
        const blocked = lockBlocked(d.petId, url.searchParams);
        if (blocked) return blocked;
        state.writePet(d.petId, "throw", { angle: d.angle, power: d.power });
        return { kind: "json", status: 200, obj: { ok: true } };
      } catch (e) {
        return {
          kind: "json",
          status: 200,
          obj: { ok: false, reason: "generate-error", message: e instanceof Error ? e.message : String(e) }
        };
      }
    }
    if (rest === "pose" || rest === "pose/report") {
      const isReport = rest === "pose/report";
      if (isReport && method !== "POST") return { kind: "json", status: 405, obj: { error: "method not allowed" } };
      if (!isReport && method !== "GET") return { kind: "json", status: 405, obj: { error: "method not allowed" } };
      let parsedPose;
      if (isReport) {
        try {
          parsedPose = JSON.parse(body ?? "null");
        } catch {
          return { kind: "json", status: 400, obj: { error: "invalid JSON body" } };
        }
      }
      try {
        const who = requirePet(url.searchParams, () => readAllConfig(configPaths));
        if (!who.ok) return who.res;
        if (isReport) {
          const p = normalizePoseInput(parsedPose);
          if (!p.ok) return { kind: "json", status: 200, obj: { ok: false, reason: p.reason, message: p.message } };
          pose.set(who.petId, p.pose);
          return { kind: "json", status: 200, obj: { ok: true } };
        }
        const display = String(who.pet.display ?? "");
        if (!displayCovers("desktop", display)) {
          return {
            kind: "json",
            status: 200,
            obj: {
              ok: false,
              reason: "pet-not-displayed",
              message: who.petId + " \u7684\u663E\u793A\u6A21\u5F0F\u662F " + display + "\uFF1B\u684C\u9762\u7AEF\u5B9E\u51B5\u53EA\u5BF9 display \u542B desktop \u7684\u5BA0\u7269\u6709",
              display
            }
          };
        }
        const snap = pose.get(who.petId);
        if (snap === void 0) {
          return {
            kind: "json",
            status: 200,
            obj: {
              ok: false,
              reason: "pose-unavailable",
              message: "\u8FD8\u6CA1\u6536\u5230\u8FC7\u8FD9\u53EA\u5BA0\u7269\u7684\u684C\u9762\u7AEF\u5B9E\u51B5\uFF08\u684C\u9762\u7AEF\u6CA1\u8D77\u6765\uFF0C\u6216\u521A\u91CD\u542F\u8FD8\u6CA1\u6765\u5F97\u53CA\u4E0A\u62A5\uFF09"
            }
          };
        }
        return { kind: "json", status: 200, obj: { ok: true, petId: who.petId, ...snap } };
      } catch (e) {
        return {
          kind: "json",
          status: 200,
          obj: { ok: false, reason: "generate-error", message: e instanceof Error ? e.message : String(e) }
        };
      }
    }
    const playbackPath = rest === "playback" || rest.startsWith("playback/") ? parsePlaybackPath(rest) : void 0;
    if (playbackPath) {
      const playbackId = playbackPath.playbackId;
      if (playbackPath.isReport) {
        if (method !== "POST") return { kind: "json", status: 405, obj: { error: "method not allowed" } };
        let reported;
        try {
          reported = JSON.parse(body ?? "null");
        } catch {
          return { kind: "json", status: 400, obj: { error: "invalid JSON body" } };
        }
        const o = reported && typeof reported === "object" ? reported : {};
        const outcome = playback.report(playbackId, o.status, o.reason);
        if (outcome === "unknown") return { kind: "json", status: 404, obj: { error: "unknown playback" } };
        if (outcome === "invalid") return { kind: "json", status: 400, obj: { error: "invalid status" } };
        return { kind: "json", status: 200, obj: { ok: true } };
      }
      if (method !== "GET") return { kind: "json", status: 405, obj: { error: "method not allowed" } };
      const record = playback.get(playbackId);
      if (!record) return { kind: "json", status: 404, obj: { error: "unknown playback" } };
      const parsed = parseWaitQuery(url.searchParams.get("wait"), url.searchParams.get("timeout"));
      if (parsed.kind === "error") return { kind: "json", status: 400, obj: { error: parsed.error } };
      if (parsed.kind === "none") {
        return { kind: "json", status: 200, obj: { ...record, matched: false } };
      }
      const { wait: waitList, timeoutMs } = parsed;
      if (waitList.includes(record.status)) {
        return { kind: "json", status: 200, obj: { ...record, matched: true } };
      }
      return await new Promise((resolveWait) => {
        let settled = false;
        const settle = (result) => {
          if (settled) return;
          settled = true;
          resolveWait(result);
        };
        const cancel = playback.wait({
          playbackId,
          wait: waitList,
          timeoutMs,
          // 唤醒时**不需要**再取消：store 在回调前已把等待者摘掉（超时定时器也清了）
          onWake: (r, matched) => settle({ kind: "json", status: 200, obj: { ...r, matched } })
        });
        if (cancel === void 0) {
          settle({ kind: "json", status: 404, obj: { error: "unknown playback" } });
          return;
        }
        const onAbort = () => {
          cancel();
          settle({ kind: "none" });
        };
        if (signal?.aborted) {
          onAbort();
          return;
        }
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    }
    if (rest === "chat") {
      if (method !== "GET" && method !== "POST") {
        return { kind: "json", status: 405, obj: { error: "method not allowed" } };
      }
      try {
        const roundsRaw = method === "GET" ? url.searchParams.get("rounds") : null;
        let roundsOverride = null;
        if (roundsRaw !== null && roundsRaw.trim() !== "") {
          const n = Number(roundsRaw);
          if (!Number.isInteger(n) || n < 0 || n > 200) {
            return {
              kind: "json",
              status: 200,
              obj: { ok: false, reason: "bad-request", message: "rounds \u5FC5\u987B\u662F 0\u2013200 \u7684\u6574\u6570\uFF08\u4E0D\u4F20\u5219\u7528\u914D\u7F6E\uFF09" }
            };
          }
          roundsOverride = n;
        }
        let cfgCache;
        const cfg = () => cfgCache ??= readAllConfig(configPaths);
        const who = requirePet(url.searchParams, cfg, { surface: method === "POST" });
        if (!who.ok) return who.res;
        const petId2 = who.petId;
        if (method === "GET") {
          const mem = await readMemory();
          const bucket = mem[who.entry] ?? {};
          const list = (bucket[petId2]?.messages ?? []).slice();
          const rounds = roundsOverride ?? memoryRounds(who.conf);
          const messages = sliceMemoryRounds(list, rounds);
          return { kind: "json", status: 200, obj: { ok: true, messages, rounds } };
        }
        if (method === "POST") {
          const parsed = JSON.parse(body ?? "null") ?? {};
          const text = typeof parsed.text === "string" ? parsed.text.trim() : "";
          if (!text) {
            return { kind: "json", status: 200, obj: { ok: false, reason: "bad-request", message: "\u6D88\u606F\u4E3A\u7A7A" } };
          }
          if (text.length > 2e3) {
            return {
              kind: "json",
              status: 200,
              obj: { ok: false, reason: "bad-request", message: "\u6D88\u606F\u8FC7\u957F\uFF08\u9650 2000 \u5B57\uFF09" }
            };
          }
          const result = await chatWithPet(petId2, text);
          return { kind: "json", status: 200, obj: result };
        }
      } catch (e) {
        return {
          kind: "json",
          status: 200,
          obj: { ok: false, reason: "generate-error", message: e instanceof Error ? e.message : String(e) }
        };
      }
    }
    const [scope, ...restParts] = rest.split("/");
    if (scope === "font") {
      const fontRoot = join5(PACKAGE_ROOT, "assets", "fonts");
      const fontFile = resolveExisting(fontRoot, restParts.join("/"));
      if (fontFile === void 0) return { kind: "text", status: 404, body: "dsh-pet: font not found" };
      const ext2 = fontFile.slice(fontFile.lastIndexOf(".")).toLowerCase();
      return { kind: "file", file: fontFile, contentType: MIME[ext2] ?? "application/octet-stream" };
    }
    if (scope === "pic") {
      if (restParts[0] === "memes") {
        const segs = restParts.slice(1);
        const scoped = segs.length >= 2;
        const assetRoot = scoped ? segs[0] : "main";
        if (scoped && (assetRoot.length > 64 || ID_FORBIDDEN.test(assetRoot))) {
          return { kind: "text", status: 400, body: "dsh-pet: invalid asset root" };
        }
        const rel = (scoped ? segs.slice(1) : segs).join("/");
        let picFile2;
        for (const dir of memeDirsFor(assetRoot)) {
          picFile2 = resolveExisting(dir, rel);
          if (picFile2 !== void 0) break;
        }
        if (picFile2 === void 0) return { kind: "text", status: 404, body: "dsh-pet: pic not found" };
        const ext3 = picFile2.slice(picFile2.lastIndexOf(".")).toLowerCase();
        return { kind: "file", file: picFile2, contentType: MIME[ext3] ?? "application/octet-stream" };
      }
      const picRoot = join5(PACKAGE_ROOT, "assets", "pic");
      const picFile = resolveExisting(picRoot, restParts.join("/"));
      if (picFile === void 0) return { kind: "text", status: 404, body: "dsh-pet: pic not found" };
      const ext2 = picFile.slice(picFile.lastIndexOf(".")).toLowerCase();
      return { kind: "file", file: picFile, contentType: MIME[ext2] ?? "application/octet-stream" };
    }
    if (scope !== "thumb") {
      return { kind: "text", status: 400, body: "dsh-pet: expected /dsh-pet-7340/thumb/<petId>/<file>" };
    }
    const [petId, ...nameParts] = restParts;
    if (!petId || nameParts.length === 0) {
      return { kind: "text", status: 400, body: "dsh-pet: expected /dsh-pet-7340/thumb/<petId>/<file>" };
    }
    if (ID_FORBIDDEN.test(petId)) {
      return { kind: "text", status: 400, body: "dsh-pet: invalid pet id" };
    }
    const fileName = nameParts.join("/");
    const ext = fileName.slice(fileName.lastIndexOf(".")).toLowerCase();
    if (ext !== ".webm" && ext !== ".mov") {
      return { kind: "text", status: 400, body: "dsh-pet: unsupported animation format (expected .webm or .mov)" };
    }
    const extraAnimDir = resolveAsset(petConfigDir, petId + "-animation");
    const findAnim = (e) => {
      const name = fileName.replace(/\.(webm|mov)$/i, "") + e;
      return extraAnimDir !== void 0 && existsSync5(extraAnimDir) ? resolveExisting(extraAnimDir, name) : resolveExisting(userRootFor(e), name) ?? resolveExisting(assetRootFor(e), name);
    };
    let file = findAnim(ext);
    let servedExt = ext;
    if (file === void 0 && ext === ".mov") {
      const fb = findAnim(".webm");
      if (fb !== void 0) {
        file = fb;
        servedExt = ".webm";
      }
    }
    if (file === void 0) return { kind: "text", status: 404, body: "dsh-pet: asset not found" };
    return { kind: "file", file, contentType: MIME[servedExt] ?? "application/octet-stream" };
  };
  ctx.effect(
    () => ctx.webServer.register({
      kind: "prefix",
      path: ROUTE_PREFIX,
      handler: async (req, res) => {
        const abort = new AbortController();
        const onClose = () => abort.abort();
        res.on("close", onClose);
        try {
          const body = req.method === "PUT" || req.method === "POST" ? await readBody(req) : void 0;
          const result = await handlePetRoute(req.url ?? "/", req.method ?? "GET", body, abort.signal);
          res.off("close", onClose);
          if (result.kind === "json") sendJson(res, result.status, result.obj, result.headers);
          else if (result.kind === "text") sendText(res, result.status, result.body);
          else if (result.kind === "none") {
          } else sendFile(res, result.file, result.contentType);
        } catch (e) {
          res.off("close", onClose);
          if (!res.destroyed && !res.writableEnded) {
            sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
          }
        }
      }
    }),
    "dsh-pet: /dsh-pet-7340 asset route"
  );
  ctx.effect(() => {
    const dispose = ctx.on("session/event", (session, event) => {
      const type = event?.type;
      if (!type) return;
      const sessionId = String(
        session?.header?.id ?? session?.id ?? "unknown"
      );
      if (type === "todo/write") {
        if (workStatus.has(sessionId)) {
          workStatus.setTask(
            sessionId,
            currentTaskFromTodo(event)
          );
          publishWorkStatus();
        }
        return;
      }
      if (type === "user/message") {
        const source = event?.data?.source;
        if (source?.kind === "goal") {
          const flags = turnFlags.get(sessionId) ?? { goalRound: false, closing: null };
          flags.goalRound = true;
          turnFlags.set(sessionId, flags);
        }
        return;
      }
      if (type === "turn/start") {
        turnFlags.set(sessionId, { goalRound: false, closing: null });
        workStatus.setTask(sessionId, null);
        publishWorkStatus();
      }
      if (type === "tool/call" && String(event?.data?.name ?? "") === GOAL_UPDATE_TOOL) {
        const action = goalUpdateAction(String(event?.data?.arguments ?? ""));
        if (action) {
          const flags = turnFlags.get(sessionId) ?? { goalRound: false, closing: null };
          flags.closing = action;
          turnFlags.set(sessionId, flags);
        }
      }
      const next = reduceWorkStatus(
        event,
        turnFlags.get(sessionId)
      );
      if (!next) {
        if (type === "turn/end") {
          turnFlags.delete(sessionId);
          cancelTerminalCleanup(sessionId);
          workStatus.clear(sessionId);
          publishWorkStatus();
        }
        return;
      }
      const seq = Number(event.seq ?? 0);
      if (!workStatus.setState(sessionId, next, seq)) return;
      publishWorkStatus();
      if (next === "success" || next === "error") scheduleTerminalCleanup(sessionId);
      else cancelTerminalCleanup(sessionId);
    });
    return () => {
      dispose();
      for (const t of terminalTimers.values()) clearTimeout(t);
      terminalTimers.clear();
    };
  }, "dsh-pet: work-status session events");
  ctx.effect(() => {
    const sessionDispose = ctx.on(
      "session/event",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (session, event) => {
        if (!shouldNotifySession(session)) return;
        if (isCompletionTurnEnd(event)) {
          scheduleCompletionNotify(sessionIdOf(session), event);
          return;
        }
        const frame = reduceNotifyFrame(event);
        if (frame) pushNotifyFrame(withSessionId(frame, sessionIdOf(session)));
      }
    );
    const errorDispose = ctx.on(
      "agent/error",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (payload) => {
        pushNotifyFrame(agentErrorFrame(payload?.error));
      }
    );
    return () => {
      for (const t of notifyActivityTimers.values()) clearTimeout(t);
      notifyActivityTimers.clear();
      sessionDispose();
      errorDispose();
    };
  }, "dsh-pet: notify frames");
  ctx.effect(
    () => ctx.commands.register({
      name: "balance",
      description: "\u624B\u52A8\u89E6\u53D1\u684C\u5BA0\u4F59\u989D\u663E\u793A\uFF08\u7ACB\u5373\u5F39\u51FA\u4F59\u989D\u6C14\u6CE1\uFF09",
      handler: () => {
        void refreshBalance(true);
        return { kind: "success", text: "\u5DF2\u89E6\u53D1\u684C\u5BA0\u4F59\u989D\u663E\u793A" };
      }
    }),
    "dsh-pet: /balance command"
  );
  ctx.effect(() => {
    let disposed2 = false;
    let timer = null;
    function arm(sec) {
      if (disposed2) return;
      timer = setTimeout(() => void tick(), Math.max(1e3, sec * 1e3));
    }
    async function tick() {
      let sec;
      try {
        const cfg = readAllConfig(configPaths);
        sec = balancePeriodSec(cfg);
        if (flattenPetList(cfg).some((p) => p.balanceEnabled === true)) await refreshBalance();
      } catch {
        return;
      }
      arm(sec);
    }
    void tick();
    return () => {
      disposed2 = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, "dsh-pet: balance poll");
  ctx.effect(() => {
    let disposed2 = false;
    let timer = null;
    function arm(sec) {
      if (disposed2) return;
      timer = setTimeout(() => void tick(), Math.max(1e3, sec * 1e3));
    }
    function tick() {
      let next = 300;
      try {
        const cfg = readAllConfig(configPaths);
        const now = Date.now();
        let min = Infinity;
        for (const pet of flattenPetList(cfg)) {
          const petId = String(pet.id ?? "");
          if (!petId) continue;
          const found = findPetInstance(cfg, petId);
          if (!found) continue;
          const schedule = automaticWhisperSchedule(
            ctx.standaloneAi,
            pet.whisperEnabled === true,
            whisperPeriodSec(found.conf)
          );
          if (!schedule.enabled) continue;
          const sec = schedule.periodSec;
          min = Math.min(min, sec);
          if (now - (lastWhisperAt.get(petId) ?? 0) < sec * 1e3) continue;
          if (lock.locked(petId)) continue;
          lastWhisperAt.set(petId, now);
          void publishWhisper(petId).catch(() => {
          });
        }
        if (Number.isFinite(min)) next = min;
      } catch {
        return;
      }
      arm(next);
    }
    void tick();
    return () => {
      disposed2 = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, "dsh-pet: whisper poll");
  ctx.effect(
    () => ctx.commands.register({
      name: "pet",
      description: "\u9009\u62E9\u684C\u5BA0\uFF08/chat \u5BF9\u8BDD\u7684\u76EE\u6807\uFF1B\u652F\u6301\u9009\u62E9\u6846\u6216\u624B\u8F93 id/\u540D\u5B57\uFF09",
      input: { hint: "[\u5BA0\u7269 id \u6216\u540D\u5B57]\uFF08\u7559\u7A7A\u67E5\u770B\u5F53\u524D\uFF09" },
      handler: ({ rawInput }) => {
        const arg = rawInput.trim();
        let eff;
        try {
          eff = effectivePetList();
        } catch {
          eff = [];
        }
        if (!arg) {
          const cur = resolveActivePetId();
          const found = eff.find((p) => String(p.id) === cur);
          return {
            kind: "success",
            text: "\u5F53\u524D\u684C\u5BA0\uFF1A" + (found ? petDisplayName(found) : cur || "\uFF08\u65E0\u53EF\u4EA4\u4E92\u684C\u5BA0\uFF09")
          };
        }
        const byId = eff.find((p) => String(p.id) === arg);
        if (byId) {
          activePetId = String(byId.id);
          return { kind: "success", text: "\u5DF2\u9009\u62E9\u684C\u5BA0\uFF1A" + petDisplayName(byId) };
        }
        const byName = eff.filter((p) => petDisplayName(p) === arg);
        if (byName.length === 1) {
          activePetId = String(byName[0].id);
          return { kind: "success", text: "\u5DF2\u9009\u62E9\u684C\u5BA0\uFF1A" + petDisplayName(byName[0]) };
        }
        if (byName.length > 1) {
          return {
            kind: "error",
            text: "\u300C" + arg + "\u300D\u6709 " + byName.length + " \u53EA\u684C\u5BA0\uFF08id\uFF1A" + byName.map((p) => String(p.id)).join("\u3001") + "\uFF09\uFF0C\u8BF7\u7528 id \u6307\u5B9A"
          };
        }
        return { kind: "error", text: "\u627E\u4E0D\u5230\u684C\u5BA0\u300C" + arg + "\u300D\uFF08id \u6216\u540D\u5B57\u90FD\u884C\uFF1B/pet \u56DE\u8F66\u53EF\u6253\u5F00\u9009\u62E9\u6846\uFF09" };
      }
    }),
    "dsh-pet: /pet command"
  );
  ctx.effect(
    () => ctx.commands.register({
      name: "chat",
      description: "\u4E0E\u684C\u5BA0\u5BF9\u8BDD\uFF1A\u7559\u7A7A = \u788E\u788E\u5FF5\u4E00\u53E5\uFF1B\u8F93\u5165\u6D88\u606F = \u6B63\u5E38\u5BF9\u8BDD",
      input: { hint: "[\u6D88\u606F]\uFF08\u7559\u7A7A = \u788E\u788E\u5FF5\uFF09" },
      handler: ({ rawInput }) => {
        const petId = resolveActivePetId();
        if (!petId) return { kind: "error", text: "\u6CA1\u6709\u53EF\u4EA4\u4E92\u7684\u684C\u5BA0" };
        const text = rawInput.trim();
        if (!text) {
          void publishWhisper(petId).catch(
            (e) => console.warn("[dsh-pet] \u788E\u788E\u5FF5\u5F02\u5E38\uFF1A" + (e instanceof Error ? e.message : String(e)))
          );
          return { kind: "success", text: "\u5DF2\u8BA9\u684C\u5BA0\u788E\u788E\u5FF5\u4E00\u53E5" };
        }
        if (text.length > 2e3) return { kind: "error", text: "\u6D88\u606F\u8FC7\u957F\uFF08\u9650 2000 \u5B57\uFF09" };
        void chatWithPet(petId, text).then((r) => {
          if (!r.ok) {
            console.warn("[dsh-pet] \u5BF9\u8BDD\u5931\u8D25 reason=" + r.reason + (r.message ? " " + r.message : ""));
          }
        });
        return { kind: "success", text: "\u5DF2\u53D1\u9001\uFF0C\u684C\u5BA0\u9A6C\u4E0A\u56DE\u5E94" };
      }
    }),
    "dsh-pet: /chat command"
  );
  ctx.effect(() => () => {
    disposed = true;
    if (workFlushTimer !== null) {
      clearTimeout(workFlushTimer);
      workFlushTimer = null;
    }
    lock.releaseAll();
    playback.cancelAll();
    state.cancelAll();
    stopHelper("dsh-host-stop");
  });
  startHelper();
}

// upstream/src/standalone/context.ts
var STANDALONE_PROVIDER = "standalone";
function createStandaloneLogger() {
  const stamp = () => (/* @__PURE__ */ new Date()).toISOString().replace("T", " ").slice(0, 19);
  const write = (level, message) => {
    console.log(`[dsh-pet-standalone ${stamp()}] ${level} ${message}`);
  };
  return {
    info: (message) => write("INFO ", message),
    warn: (message) => write("WARN ", message),
    error: (message) => write("ERROR", message),
    debug: (message) => {
      if (process.env.DSH_PET_STANDALONE_DEBUG === "1") write("DEBUG", message);
    }
  };
}
function createStandaloneContext(options) {
  const { logger: logger2, ai } = options;
  const routes2 = options.routes ?? [];
  const failures = [];
  const disposers = [];
  let disposed = false;
  const portOf = () => typeof options.port === "function" ? options.port() : options.port;
  const webServer = {
    /** 读取时取值：服务先监听、端口确定后才 apply，插件在 launchHelper 里读到的就是真端口 */
    get port() {
      return portOf();
    },
    register(spec) {
      routes2.push({ kind: spec.kind, path: spec.path, handler: spec.handler });
      return () => {
        const index = routes2.findIndex((route) => route.handler === spec.handler);
        if (index >= 0) routes2.splice(index, 1);
      };
    }
  };
  const context2 = {
    /**
     * 与 Cordis 同语义：跑一次注册函数并收集它返回的释放函数。
     * 单项失败按 DSH 的 effect 隔离口径处理：记录 + 打日志，不让整个插件起不来
     * （源码形态下包内 assets 不可达时，正是这里会抛）。
     */
    effect(fn) {
      try {
        const dispose = fn();
        if (typeof dispose === "function") disposers.push(dispose);
        return dispose;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push(message);
        logger2.error(`\u521D\u59CB\u5316\u67D0\u9879\u5931\u8D25\uFF08\u5DF2\u8DF3\u8FC7\uFF09\uFF1A${message}`);
        return void 0;
      }
    },
    /** 独立模式没有 DSH 会话事件：不订阅，工作状态保持空闲 */
    on() {
      return () => {
      };
    },
    logger: logger2,
    webServer,
    connection: { authenticatedUrl: options.authenticatedUrl ?? ((baseUrl) => baseUrl) },
    ...ai ? {
      standaloneAi: {
        isReady: () => ai.isReady(),
        canWhisper: () => ai.canWhisper(),
        whisperIntervalSec: () => ai.getSettings().whisperIntervalSec
      }
    } : {},
    commands: { register: () => () => {
    } },
    agentDefaultModel: {
      currentSelection: () => ai?.currentSelection() ?? { provider: STANDALONE_PROVIDER, model: "" }
    },
    credentials: { resolve: async () => void 0 },
    llm: ai ? {
      listProviders: () => ai.listProviders(),
      listModels: (provider) => ai.listModels(provider),
      resolveModelInfo: (provider, model, signal) => ai.resolveModelInfo(provider, model, signal),
      stream: (request) => ai.stream(request)
    } : {
      listProviders: () => [],
      listModels: async () => [],
      /**
       * 模型元数据查询。DSH 的契约是
       * `resolveModelInfo(provider, model, signal?): Promise<LlmResolvedModelInfo>` —— **异步**。
       * 替身必须同样返回 Promise：同步返回 undefined 时，任何 `.then()` 或不带 `?.` 的取值
       * 都会立刻炸（与 stream 同一类形状错误）。
       *
       * 目前唯一消费方 `supportsReasoningOff` 用 `await` + `?.` + try/catch 包着，所以不炸——
       * 但那是靠消费方防御，不是靠形状正确。形状对不上，就不该指望下一个消费方也这么写。
       */
      resolveModelInfo: async () => void 0,
      /**
       * 生成入口：独立模式没有模型后端。
       *
       * 必须是 **AsyncIterable**——DSH 的契约是 `stream(options): AsyncIterable<StreamChunk>`，
       * 调用方一律 `for await (const chunk of llm.stream(...))` 消费。错误在首次 `next()` 时抛出，
       * 正好落在调用方已有的 try/catch 里，转成 `ok:false / generate-error` 的结构化失败。
       *
       * **不能**写成 `async () => { throw ... }`：那返回 Promise 而非 AsyncIterable，
       * `for await` 会立刻抛 TypeError（文案由 V8 生成，形如 "llm.stream(...) is not a function
       * or its return value is not async iterable"），同时那个 rejected promise 无人接管，
       * 以 unhandled rejection **直接终止进程**。0.3.4 的崩溃根因即此：配置里设了
       * whisperModel/chatModel 就必崩，因为只有配了模型才会真的走到这里。
       */
      // 不用 `async function*`：一个只有 throw、没有 yield 的生成器会被 eslint 的
      // require-yield 拦下；而这里恰恰不该 yield 任何东西（独立模式没有模型后端）。
      // 显式给出 AsyncIterable 的形状，也是对契约最直接的表达。
      stream: () => ({
        [Symbol.asyncIterator]() {
          return {
            next: async () => {
              throw new Error("dsh-pet standalone: \u72EC\u7ACB\u6A21\u5F0F\u672A\u63A5\u5165\u6A21\u578B\uFF08\u788E\u788E\u5FF5/\u5BF9\u8BDD\u4E0D\u53EF\u7528\uFF09");
            }
          };
        }
      })
    }
  };
  return {
    ctx: context2,
    routes: routes2,
    failures,
    async dispose() {
      if (disposed) return;
      disposed = true;
      ai?.dispose();
      for (const dispose of disposers.splice(0).reverse()) {
        try {
          await dispose();
        } catch (error) {
          logger2.warn(`\u91CA\u653E\u67D0\u9879\u5931\u8D25\uFF1A${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
  };
}

// upstream/src/standalone/request-security.ts
import { randomBytes, timingSafeEqual } from "node:crypto";
function rejectRequest(res, status, error) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify({ error }));
  return false;
}
function publicRead(req) {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  let path;
  try {
    path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
  } catch {
    return false;
  }
  if (["/standalone-ai/settings", "/shutdown"].includes(path)) return false;
  if (/^\/dsh-pet-\d+\/(?:whisper|chat)(?:\/|$)/.test(path)) return false;
  return ["/", "/health", "/standalone-ai/", "/standalone-ai/settings.js", "/standalone-ai/settings.css"].includes(path) || /^\/dsh-pet-\d+\//.test(path);
}
function createRequestSecurity() {
  const token = randomBytes(32).toString("base64url");
  return {
    token,
    authenticatedUrl(baseUrl) {
      const base = new URL(baseUrl);
      if (base.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(base.hostname) || base.username || base.password) {
        throw new Error("\u8BBE\u7F6E\u5730\u5740\u5FC5\u987B\u662F\u672C\u673A HTTP \u5730\u5740");
      }
      return `${base.origin}/standalone-ai/#token=${token}`;
    },
    authorize(req, res) {
      const host = req.headers.host;
      const port2 = req.socket.localPort;
      if (!port2 || host !== `127.0.0.1:${port2}` && host !== `localhost:${port2}`) {
        return rejectRequest(res, 403, "\u4EC5\u5141\u8BB8\u5F53\u524D\u672C\u673A\u5730\u5740");
      }
      if (req.headers.origin !== void 0 && req.headers.origin !== `http://${host}` || req.headers["sec-fetch-site"] === "cross-site") {
        return rejectRequest(res, 403, "\u4E0D\u5141\u8BB8\u8DE8\u7AD9\u8BF7\u6C42");
      }
      try {
        if (publicRead(req)) return true;
      } catch {
        return rejectRequest(res, 400, "\u8BF7\u6C42\u5730\u5740\u65E0\u6548");
      }
      const supplied = req.headers["x-dsh-pet-token"];
      if (typeof supplied !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(supplied) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))) {
        return rejectRequest(res, 403, "\u8BF7\u4ECE\u684C\u5BA0\u83DC\u5355\u91CD\u65B0\u6253\u5F00\u8BBE\u7F6E");
      }
      return true;
    }
  };
}
function secureResponse(res, pathname) {
  const writeHead = res.writeHead.bind(res);
  const isPublicOp = pathname === "/" || pathname === "/health";
  res.writeHead = ((status, ...args) => {
    const filtered = isPublicOp ? args : args.map((value) => {
      if (Array.isArray(value)) {
        return value.reduce((result, item, index) => {
          if (index % 2 === 0 && !String(item).toLowerCase().startsWith("access-control-")) {
            return [...result, String(item), String(value[index + 1])];
          }
          return result;
        }, []);
      }
      if (value !== null && typeof value === "object") {
        return Object.fromEntries(
          Object.entries(value).filter(([name]) => !name.toLowerCase().startsWith("access-control-"))
        );
      }
      return value;
    });
    if (!isPublicOp) {
      for (const name of res.getHeaderNames()) {
        if (name.toLowerCase().startsWith("access-control-")) res.removeHeader(name);
      }
    }
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader("cache-control", "no-store");
    return Reflect.apply(writeHead, res, [status, ...filtered]);
  });
}

// upstream/src/standalone/server.ts
import { timingSafeEqual as timingSafeEqual2 } from "node:crypto";
import { createServer } from "node:http";

// upstream/src/standalone/request-body.ts
import { Readable } from "node:stream";
var MAX_REQUEST_BYTES = 1024 * 1024;
var MAX_SETTINGS_BYTES = 16 * 1024;
var BODY_TIMEOUT_MS = 5e3;
async function boundedRequest(req, res, limit, timeoutMs = BODY_TIMEOUT_MS) {
  const length = req.headers["content-length"];
  if (length !== void 0 && (!/^\d+$/.test(length) || Number(length) > limit)) {
    rejectRequest(res, 413, "\u8BF7\u6C42\u6B63\u6587\u8FC7\u5927");
    return void 0;
  }
  const chunks = [];
  const body = await new Promise((resolve3) => {
    let size = 0;
    const finish = (status) => {
      clearTimeout(timer);
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
      req.off("aborted", onError);
      if (status !== void 0) {
        req.pause();
        if (!res.writableEnded && !res.destroyed)
          rejectRequest(res, status, status === 408 ? "\u8BFB\u53D6\u8BF7\u6C42\u8D85\u65F6" : "\u8BF7\u6C42\u6B63\u6587\u65E0\u6548\u6216\u8FC7\u5927");
        resolve3(void 0);
      } else resolve3(Buffer.concat(chunks));
    };
    const onData = (chunk) => {
      size += chunk.length;
      if (size > limit) finish(413);
      else chunks.push(Buffer.from(chunk));
    };
    const onEnd = () => finish();
    const onError = () => finish(400);
    const timer = setTimeout(() => finish(408), timeoutMs);
    timer.unref();
    req.on("data", onData);
    req.once("end", onEnd);
    req.once("error", onError);
    req.once("aborted", onError);
  });
  if (body === void 0) return void 0;
  return Object.assign(Readable.from([body]), {
    method: req.method,
    url: req.url,
    headers: req.headers,
    rawHeaders: req.rawHeaders,
    socket: req.socket,
    httpVersion: req.httpVersion
  });
}

// upstream/src/standalone/settings.ts
import { z } from "zod";
var endpoint = z.string().max(2048).refine((value) => {
  if (value === "") return true;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
}, "\u63A5\u53E3\u5730\u5740\u5FC5\u987B\u662F HTTP(S) \u5730\u5740\uFF0C\u4E14\u4E0D\u80FD\u542B\u8D26\u53F7\u3001\u67E5\u8BE2\u53C2\u6570\u6216\u7247\u6BB5");
var settingsSchema = z.object({
  protocol: z.enum(["openai-compatible", "anthropic"]).optional(),
  baseUrl: endpoint.optional(),
  model: z.string().max(200).optional(),
  apiKey: z.string().max(8192).optional(),
  clearApiKey: z.boolean().optional(),
  enabled: z.boolean().optional(),
  automaticWhispers: z.boolean().optional(),
  whisperIntervalSec: z.number().int().min(60).max(86400).optional(),
  maxTokens: z.number().int().min(128).max(4096).optional(),
  timeoutMs: z.number().int().min(1e3).max(6e4).optional()
}).strict();
function validateSettings(input) {
  const result = settingsSchema.safeParse(input);
  if (!result.success) throw new Error("\u8BBE\u7F6E\u65E0\u6548\uFF1A\u8BF7\u68C0\u67E5\u534F\u8BAE\u3001\u63A5\u53E3\u5730\u5740\u3001\u95F4\u9694\uFF08\u81F3\u5C11 60 \u79D2\uFF09\u548C\u8F93\u51FA\u4E0A\u9650\uFF08128\u20134096\uFF09");
  return result.data;
}
var publicNames = [
  "protocol",
  "baseUrl",
  "model",
  "enabled",
  "automaticWhispers",
  "whisperIntervalSec",
  "maxTokens",
  "timeoutMs",
  "hasKey"
];
function publicSettings(input) {
  if (input === null || typeof input !== "object") return {};
  const record = input;
  return Object.fromEntries(
    publicNames.filter((name) => Object.prototype.hasOwnProperty.call(record, name)).map((name) => [name, record[name]])
  );
}

// upstream/src/standalone/settings-page.ts
var settingsPage = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>\u684C\u5BA0 AI \u8BBE\u7F6E</title><link rel="stylesheet" href="/standalone-ai/settings.css">
<script src="/standalone-ai/settings.js" defer></script></head><body>
<main><header><span class="fish" aria-hidden="true">\u{1F43E}</span><p class="local">\u72EC\u7ACB\u684C\u5BA0 / \u672C\u673A\u8BBE\u7F6E</p>
<h1>\u684C\u5BA0 AI \u8BBE\u7F6E</h1><p class="intro">\u914D\u7F6E\u4F60\u7684\u5927\u6A21\u578B API \u63A5\u53E3\uFF0C\u5F00\u542F\u684C\u9762\u804A\u5929\u4E0E\u788E\u788E\u5FF5\u3002<br>\u6240\u6709\u8BBE\u7F6E\u4EC5\u4FDD\u5B58\u5728\u672C\u673A\uFF0C\u652F\u6301\u5373\u65F6\u6D4B\u8BD5\u8FDE\u63A5\u3002</p></header>
<form id="settings" aria-describedby="privacy">
<fieldset><legend>\u6A21\u578B\u8FDE\u63A5</legend>
<label for="protocol">\u63A5\u53E3\u534F\u8BAE</label><select id="protocol" name="protocol"><option value="openai-compatible">OpenAI \u517C\u5BB9</option><option value="anthropic">Anthropic</option></select>
<label for="baseUrl">\u63A5\u53E3\u5730\u5740\uFF08Base URL\uFF09</label><input id="baseUrl" name="baseUrl" type="url" placeholder="https://example.com/v1" maxlength="2048" spellcheck="false" aria-describedby="endpoint-note"><p class="hint" id="endpoint-note">\u586B\u5199\u670D\u52A1\u5546\u63D0\u4F9B\u7684\u57FA\u7840\u63A5\u53E3\u5730\u5740\uFF08\u652F\u6301 HTTP \u4E0E HTTPS\uFF0C\u901A\u5E38\u4EE5 /v1 \u7ED3\u5C3E\uFF09\u3002\u4E0D\u8981\u628A\u5BC6\u94A5\u653E\u8FDB\u5730\u5740\u3002</p>
<label for="model">\u6A21\u578B\u540D\u79F0</label><input id="model" name="model" type="text" maxlength="200" placeholder="\u586B\u5199\u670D\u52A1\u5546\u7684\u6A21\u578B ID\uFF0C\u4F8B\u5982 deepseek-chat" spellcheck="false">
<div class="key-heading"><label for="apiKey">API \u5BC6\u94A5</label><span id="key-state" class="hint">\u5C1A\u672A\u8BFB\u53D6</span></div>
<input id="apiKey" name="apiKey" type="password" autocomplete="new-password" maxlength="8192" placeholder="\u7559\u7A7A\u4FDD\u7559\u5DF2\u4FDD\u5B58\u7684\u5BC6\u94A5" aria-describedby="key-note">
<p id="key-note" class="hint">\u5BC6\u94A5\u53EA\u5199\u5165\u672C\u673A\u914D\u7F6E\uFF0C\u4E0D\u4F1A\u56DE\u663E\u3002\u7559\u7A7A\u4E0D\u4F1A\u5220\u9664\u65E7\u5BC6\u94A5\u3002</p>
<label class="check clear"><input id="clearApiKey" type="checkbox">\u6E05\u9664\u5DF2\u4FDD\u5B58\u7684\u5BC6\u94A5\uFF0C\u5E76\u5173\u95ED AI</label>
<label class="check enabled"><input id="enabled" type="checkbox">\u542F\u7528 AI \u5BF9\u8BDD</label>
<div class="test-row"><button id="test-btn" type="button">\u6D4B\u8BD5\u8FDE\u63A5</button><span id="test-result" class="test-result" role="status" aria-live="polite"></span></div>
</fieldset>
<fieldset><legend>\u5B9A\u65F6\u81EA\u52A8\u788E\u788E\u5FF5</legend>
<label class="check"><input id="automaticWhispers" type="checkbox" aria-describedby="cost">\u5F00\u542F\u81EA\u52A8\u788E\u788E\u5FF5</label>
<p id="cost" class="notice">\u5F00\u542F\u540E\uFF0C\u684C\u5BA0\u4F1A\u6309\u8BBE\u5B9A\u95F4\u9694\u5B9A\u65F6\u8C03\u7528\u6A21\u578B\u5E76\u5728\u684C\u9762\u4E0A\u8BF4\u8BDD\u5192\u6CE1\uFF08\u4EA7\u751F API \u8D39\u7528\uFF09\u3002\u9ED8\u8BA4\u5173\u95ED\uFF1B\u53F3\u952E\u83DC\u5355\u4E2D\u7684\u624B\u52A8\u5BF9\u8BDD\u4E0E\u624B\u52A8\u788E\u788E\u5FF5\u4E0D\u53D7\u6B64\u5F00\u5173\u9650\u5236\u3002</p>
<div class="pair"><div><label for="whisperIntervalSec">\u788E\u788E\u5FF5\u95F4\u9694\uFF08\u79D2\uFF09</label><input id="whisperIntervalSec" type="number" min="60" max="86400" step="1" value="300" required></div>
<div><label for="maxTokens">\u5355\u6B21\u8F93\u51FA\u4E0A\u9650\uFF08tokens\uFF09</label><input id="maxTokens" type="number" min="128" max="4096" step="1" value="1024" required></div></div>
<p class="hint">\u95F4\u9694\u81F3\u5C11 60 \u79D2\uFF0C\u9ED8\u8BA4 300 \u79D2\u3002\u8F93\u51FA\u4E0A\u9650\u8D8A\u5C0F\uFF0C\u5355\u6B21\u56DE\u590D\u8D8A\u7B80\u77ED\u3002</p>
</fieldset>
<footer><p id="privacy">\u6240\u6709\u914D\u7F6E\u4E0E\u5BC6\u94A5\u4EC5\u4FDD\u5B58\u5728\u5F53\u524D\u673A\u5668\u3002<br>\u5173\u95ED AI \u540E\uFF0C\u684C\u5BA0\u4ECD\u53EF\u6B63\u5E38\u663E\u793A\u3001\u79FB\u52A8\u4E0E\u4E92\u52A8\u3002</p><button id="save" type="submit" disabled>\u4FDD\u5B58\u5230\u672C\u673A</button></footer>
<p id="status" role="status" aria-live="polite">\u6B63\u5728\u8BFB\u53D6\u672C\u673A\u8BBE\u7F6E\u2026</p>
</form><noscript>\u9700\u8981\u542F\u7528 JavaScript \u624D\u80FD\u4FDD\u5B58\u8BBE\u7F6E\u3002\u8BF7\u4ECE\u684C\u5BA0\u83DC\u5355\u6253\u5F00\u672C\u9875\u3002</noscript></main></body></html>`;
var settingsStyle = `
:root{color-scheme:light;--ink:#203b4b;--muted:#526a78;--blue:#12618b;--line:#cbdce5;--paper:#fff;--water:#edf5fa}
*{box-sizing:border-box}body{margin:0;background:var(--water);color:var(--ink);font:16px/1.6 "Microsoft YaHei UI","PingFang SC",sans-serif}
main{max-width:720px;margin:48px auto;padding:0 24px 32px}header{padding:0 12px 28px}.fish{display:block;font:700 29px/1.3 Georgia,serif;color:var(--blue);letter-spacing:2px;margin-bottom:24px}.local{font-size:13px;color:var(--muted);margin:0 0 10px}h1{font-size:32px;line-height:1.3;letter-spacing:-1px;margin:0 0 16px;font-weight:700}.intro{margin:0;color:var(--muted)}
form{background:var(--paper);border:1px solid var(--line);border-radius:16px 16px 6px 6px;padding:28px 32px 20px}fieldset{padding:0 0 28px;margin:0 0 24px;border:0;border-bottom:1px solid var(--line);min-width:0}legend{font-size:19px;font-weight:700;margin-bottom:18px;padding:0}label{display:block;font-weight:600;font-size:14px;margin:14px 0 6px}input:not([type=checkbox]),select{display:block;width:100%;min-height:44px;border:1px solid #a5bdcb;border-radius:6px;background:#fff;color:var(--ink);padding:9px 12px;font:inherit;font-size:15px}input::placeholder{color:#6a7e8b}input[type=checkbox]{accent-color:var(--blue);width:18px;height:18px;flex-shrink:0;margin:0}.check{display:flex;align-items:center;gap:10px;min-height:32px;cursor:pointer}.enabled{margin-top:24px}.clear{font-weight:400;color:var(--muted);font-size:13px}.hint{font-size:12px;line-height:1.6;color:var(--muted);margin:7px 0 0}.key-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:14px}.key-heading label{margin:0 0 6px}.key-heading .hint{margin:0 0 6px}.notice{font-size:13px;color:#704b13;background:#fff7e7;border-left:3px solid #c18e36;margin:12px 0 16px;padding:12px 14px}.pair{display:grid;grid-template-columns:1fr 1fr;gap:20px}footer{display:flex;align-items:center;justify-content:space-between;gap:18px}footer p{font-size:12px;color:var(--muted);margin:0}button{border:0;border-radius:7px;min-height:44px;padding:10px 20px;background:var(--blue);color:#fff;font:600 15px/1.5 inherit;white-space:nowrap;cursor:pointer}button:hover{background:#0b4e73}button:disabled{opacity:.55;cursor:wait}:focus-visible{outline:3px solid #3a94c4;outline-offset:3px}#status{font-size:13px;min-height:24px;margin:18px 0 0;color:var(--blue)}#status[data-error=true]{color:#a13b30}
.test-row{display:flex;align-items:center;gap:14px;margin:20px 0 6px;flex-wrap:wrap}#test-btn{background:#fff;color:var(--blue);border:1.5px solid var(--blue);min-height:38px;padding:6px 18px;font-size:14px;border-radius:6px;cursor:pointer;font-weight:600}#test-btn:hover{background:#edf5fa}#test-btn:disabled{opacity:.6;cursor:wait}.test-result{font-size:13px;line-height:1.5;min-height:22px;flex:1 1 200px}.test-success{color:#1a7f37;font-weight:600}.test-error{color:#cf222e}.reply-preview{display:block;color:var(--muted);font-weight:normal;font-size:12px;margin-top:4px;word-break:break-all}
@media(max-width:560px){main{margin:24px auto;padding:0 14px 24px}header{padding:0 8px 24px}h1{font-size:28px}form{padding:24px 20px 16px}.pair{grid-template-columns:1fr;gap:0}footer{align-items:stretch;flex-direction:column}button{width:100%}.fish{margin-bottom:18px}}
`;
var settingsScript = `
'use strict';
(() => {
  const token = new URLSearchParams(location.hash.slice(1)).get('token') || '';
  history.replaceState(null, '', location.pathname);
  const get = id => document.getElementById(id);
  const form = get('settings');
  const status = get('status');
  const save = get('save');
  const testBtn = get('test-btn');
  const testResult = get('test-result');
  function message(text, error = false) { status.textContent = text; status.dataset.error = String(error); }
  async function request(method, body) {
    const response = await fetch('/standalone-ai/settings', {
      method, credentials: 'omit', cache: 'no-store', redirect: 'error',
      headers: { 'X-DSH-Pet-Token': token, ...(body ? {'Content-Type': 'application/json'} : {}) },
      ...(body ? {body: JSON.stringify(body)} : {})
    });
    if (!response.ok) {
      if (response.status === 403) throw new Error('\u6253\u5F00\u51ED\u636E\u5DF2\u5931\u6548\u3002\u8BF7\u4ECE\u684C\u5BA0\u83DC\u5355\u91CD\u65B0\u6253\u5F00\u8BBE\u7F6E\u3002');
      if (response.status === 429) throw new Error('\u4FDD\u5B58\u8FC7\u4E8E\u9891\u7E41\uFF0C\u8BF7\u7A0D\u7B49\u4E00\u5206\u949F\u518D\u8BD5\u3002');
      throw new Error('\u8BBE\u7F6E\u672A\u4FDD\u5B58\u3002\u8BF7\u68C0\u67E5\u63A5\u53E3\u5730\u5740\u3001\u6A21\u578B\u540D\u79F0\u4E0E\u5BC6\u94A5\uFF0C\u518D\u91CD\u8BD5\u3002');
    }
    return response.json();
  }
  function populate(data) {
    for (const id of ['protocol','baseUrl','model','whisperIntervalSec','maxTokens']) {
      if (data[id] !== undefined) get(id).value = String(data[id]);
    }
    for (const id of ['enabled','automaticWhispers']) get(id).checked = data[id] === true;
    get('key-state').textContent = data.hasKey ? '\u5DF2\u4FDD\u5B58 \xB7 \u4E0D\u56DE\u663E' : '\u5C1A\u672A\u8BBE\u7F6E';
    get('apiKey').value = '';
    get('clearApiKey').checked = false;
  }
  get('clearApiKey').addEventListener('change', () => {
    get('apiKey').disabled = get('clearApiKey').checked;
    if (get('clearApiKey').checked) {
      get('apiKey').value = '';
      get('enabled').checked = false;
      get('automaticWhispers').checked = false;
    }
  });
  if (testBtn && testResult) {
    testBtn.addEventListener('click', async () => {
      testBtn.disabled = true;
      testResult.className = 'test-result';
      testResult.textContent = '\u6B63\u5728\u6D4B\u8BD5\u8FDE\u63A5\uFF0C\u8BF7\u7A0D\u5019\u2026';
      const input = {
        protocol: get('protocol').value,
        baseUrl: get('baseUrl').value.trim(),
        model: get('model').value.trim(),
        apiKey: get('apiKey').value.trim(),
      };
      try {
        const response = await fetch('/standalone-ai/test', {
          method: 'POST',
          credentials: 'omit',
          cache: 'no-store',
          headers: {
            'X-DSH-Pet-Token': token,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(input),
        });
        const data = await response.json();
        if (data.ok) {
          testResult.className = 'test-result test-success';
          testResult.textContent = '\u2713 ' + data.message;
          if (data.reply) {
            const preview = document.createElement('span');
            preview.className = 'reply-preview';
            preview.textContent = '\u56DE\u590D: ' + data.reply;
            testResult.appendChild(preview);
          }
        } else {
          testResult.className = 'test-result test-error';
          testResult.textContent = '\u2717 ' + (data.message || data.error || '\u6D4B\u8BD5\u5931\u8D25');
        }
      } catch (error) {
        testResult.className = 'test-result test-error';
        testResult.textContent = '\u2717 \u8BF7\u6C42\u5F02\u5E38\uFF1A' + (error && error.message ? error.message : String(error));
      } finally {
        testBtn.disabled = false;
      }
    });
  }
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    save.disabled = true;
    message('\u6B63\u5728\u4FDD\u5B58\u5230\u672C\u673A\u2026');
    const input = {
      protocol: get('protocol').value, baseUrl: get('baseUrl').value.trim(), model: get('model').value.trim(),
      apiKey: get('apiKey').value, clearApiKey: get('clearApiKey').checked,
      enabled: get('enabled').checked, automaticWhispers: get('automaticWhispers').checked,
      whisperIntervalSec: Number(get('whisperIntervalSec').value), maxTokens: Number(get('maxTokens').value)
    };
    get('apiKey').value = '';
    try {
      populate(await request('POST', input));
      get('apiKey').disabled = false;
      message('\u5DF2\u4FDD\u5B58\u5230\u672C\u673A\u3002');
    } catch (error) { message(error.message, true); }
    finally { save.disabled = false; }
  });
  if (!token) { message('\u8BF7\u4ECE\u684C\u5BA0\u83DC\u5355\u6216\u672C\u673A\u542F\u52A8\u5668\u6253\u5F00\u8BBE\u7F6E\uFF0C\u4EE5\u83B7\u5F97\u672C\u6B21\u8FD0\u884C\u7684\u8BBF\u95EE\u51ED\u636E\u3002', true); return; }
  request('GET').then(data => { populate(data); save.disabled = false; message('\u8BBE\u7F6E\u53EA\u5728\u672C\u673A\u4FDD\u5B58\u3002'); })
    .catch(error => message(error.message, true));
})();
`;

// upstream/src/standalone/server.ts
var DEFAULT_STANDALONE_PORT = 3080;
var PORT_SCAN_LIMIT = 25;
function matches(route, pathname) {
  if (route.kind === "exact") return pathname === route.path;
  return pathname === route.path || pathname.startsWith(`${route.path}/`);
}
function sendJson2(res, status, body, cors = false) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    ...cors ? { "access-control-allow-origin": "*" } : {}
  });
  res.end(payload);
}
function sendAsset(res, body, type) {
  res.writeHead(200, {
    "content-type": `${type}; charset=utf-8`,
    "content-length": Buffer.byteLength(body),
    "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    "x-frame-options": "DENY"
  });
  res.end(body);
}
function fail(res, _error, logger2) {
  logger2.error("\u72EC\u7ACB\u6A21\u5F0F\u8DEF\u7531\u5904\u7406\u5931\u8D25\uFF08\u8BE6\u7EC6\u5185\u5BB9\u5DF2\u7701\u7565\u4EE5\u4FDD\u62A4\u51ED\u636E\uFF09");
  if (res.headersSent) res.destroy();
  else sendJson2(res, 500, { error: "\u672C\u673A\u670D\u52A1\u6682\u65F6\u65E0\u6CD5\u5904\u7406\u8BF7\u6C42" });
}
function settingsHandler(ai) {
  let windowStart = Date.now();
  let count = 0;
  return async (req, res) => {
    if (!ai) {
      rejectRequest(res, 503, "\u672C\u673A AI \u8BBE\u7F6E\u5C1A\u672A\u5C31\u7EEA");
      return;
    }
    if (req.method === "GET") {
      sendJson2(res, 200, publicSettings(ai.getSettings()));
      return;
    }
    if (req.method !== "POST") {
      rejectRequest(res, 405, "\u4EC5\u652F\u6301 GET \u6216 POST");
      return;
    }
    if (Date.now() - windowStart >= 6e4) {
      windowStart = Date.now();
      count = 0;
    }
    count += 1;
    if (count > 20) {
      rejectRequest(res, 429, "\u4FDD\u5B58\u8FC7\u4E8E\u9891\u7E41\uFF0C\u8BF7\u7A0D\u540E\u518D\u8BD5");
      return;
    }
    if (req.headers["content-type"]?.split(";")[0].trim().toLowerCase() !== "application/json") {
      rejectRequest(res, 415, "\u8BF7\u4F7F\u7528 JSON \u4FDD\u5B58\u8BBE\u7F6E");
      return;
    }
    try {
      const chunks = [];
      await new Promise((resolve3, reject) => {
        req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        req.once("end", resolve3);
        req.once("error", reject);
      });
      const input = validateSettings(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      sendJson2(res, 200, publicSettings(await ai.saveSettings(input)));
    } catch {
      rejectRequest(res, 400, "\u8BBE\u7F6E\u672A\u4FDD\u5B58\uFF1A\u8BF7\u68C0\u67E5\u63A5\u53E3\u5730\u5740\u3001\u6A21\u578B\u540D\u79F0\u3001\u5BC6\u94A5\u548C\u6570\u503C\u8303\u56F4");
    }
  };
}
function testHandler(ai) {
  return async (req, res) => {
    if (req.method !== "POST") {
      rejectRequest(res, 405, "\u4EC5\u652F\u6301 POST");
      return;
    }
    try {
      const chunks = [];
      await new Promise((resolve3, reject) => {
        req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        req.once("end", resolve3);
        req.once("error", reject);
      });
      const bodyStr = Buffer.concat(chunks).toString("utf8");
      const input = bodyStr ? JSON.parse(bodyStr) : {};
      if (ai?.testConnection) {
        const result = await ai.testConnection(input);
        sendJson2(res, 200, result);
      } else {
        sendJson2(res, 200, { ok: false, message: "\u5F53\u524D\u73AF\u5883\u672A\u914D\u7F6E\u6D4B\u8BD5\u80FD\u529B" });
      }
    } catch {
      sendJson2(res, 400, { ok: false, message: "\u8BF7\u6C42\u683C\u5F0F\u65E0\u6548" });
    }
  };
}
function dispatch(options, shutdownSecurity) {
  const settings = settingsHandler(options.ai);
  const tester = testHandler(options.ai);
  return (req, res, pathname) => {
    const method = req.method ?? "GET";
    if (method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    if (pathname === "/" || pathname === "/health") {
      if (method !== "GET" && method !== "HEAD") {
        rejectRequest(res, 405, "\u4EC5\u652F\u6301 GET");
        return;
      }
      sendJson2(res, 200, options.status?.() ?? { name: "dsh-pet-standalone" }, true);
      return;
    }
    if (pathname === "/shutdown") {
      if (method !== "POST") {
        rejectRequest(res, 405, "\u505C\u673A\u8BF7\u4F7F\u7528 POST");
        return;
      }
      if (shutdownSecurity) {
        const supplied = req.headers["x-dsh-pet-token"];
        if (typeof supplied !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(supplied) || !timingSafeEqual2(Buffer.from(supplied), Buffer.from(shutdownSecurity.token))) {
          rejectRequest(res, 403, "\u505C\u673A\u9700\u8981\u63D0\u4F9B\u4EE4\u724C");
          return;
        }
      }
      sendJson2(res, 200, { ok: true, stopping: true });
      queueMicrotask(() => options.onShutdown?.());
      return;
    }
    const assets = {
      "/standalone-ai/": [settingsPage, "text/html"],
      "/standalone-ai/settings.js": [settingsScript, "text/javascript"],
      "/standalone-ai/settings.css": [settingsStyle, "text/css"]
    };
    const asset = assets[pathname];
    if (asset) {
      if (method !== "GET" && method !== "HEAD") {
        rejectRequest(res, 405, "\u4EC5\u652F\u6301 GET");
        return;
      }
      sendAsset(res, asset[0], asset[1]);
      return;
    }
    if (pathname === "/standalone-ai/settings") {
      void settings(req, res).catch((error) => fail(res, error, options.logger));
      return;
    }
    if (pathname === "/standalone-ai/test") {
      void tester(req, res).catch((error) => fail(res, error, options.logger));
      return;
    }
    const route = options.routes.find((candidate) => matches(candidate, pathname));
    if (!route) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end(
        `dsh-pet-standalone: \u6CA1\u6709\u5339\u914D\u7684\u8DEF\u7531\uFF08\u5DF2\u6CE8\u518C\uFF1A${options.routes.map((item) => item.path).join(", ") || "\u65E0"}\uFF09`
      );
      return;
    }
    try {
      void Promise.resolve(route.handler(req, res)).catch((error) => fail(res, error, options.logger));
    } catch (error) {
      fail(res, error, options.logger);
    }
  };
}
function createRequestListener(options, injectedSecurity) {
  const security2 = options.security ?? injectedSecurity;
  const route = dispatch(options, security2);
  return (req, res) => {
    let pathname;
    try {
      pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    } catch {
      rejectRequest(res, 400, "\u8BF7\u6C42\u5730\u5740\u65E0\u6548");
      return;
    }
    secureResponse(res, pathname);
    if (security2 && !security2.authorize(req, res)) return;
    options.logger.debug("\u6536\u5230\u672C\u673A HTTP \u8BF7\u6C42");
    const hasBody = req.headers["transfer-encoding"] !== void 0 || Number(req.headers["content-length"] ?? 0) > 0;
    const bodyMethod = ["POST", "PUT", "PATCH", "DELETE"].includes(req.method ?? "");
    if ((hasBody || bodyMethod) && typeof req.on === "function") {
      const limit = pathname === "/standalone-ai/settings" ? MAX_SETTINGS_BYTES : MAX_REQUEST_BYTES;
      void boundedRequest(req, res, limit, options.bodyTimeoutMs).then((bounded) => {
        if (bounded) route(bounded, res, pathname);
      }).catch((error) => fail(res, error, options.logger));
    } else route(req, res, pathname);
  };
}
async function bindFirstFree(server2, preferred, logger2) {
  for (let port2 = preferred; port2 < preferred + PORT_SCAN_LIMIT; port2 += 1) {
    try {
      await new Promise((accept, reject) => {
        const onError = (error) => {
          server2.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server2.off("error", onError);
          accept();
        };
        server2.once("error", onError);
        server2.once("listening", onListening);
        server2.listen(port2, "127.0.0.1");
      });
      const address = server2.address();
      const bound = typeof address === "object" && address !== null ? address.port : port2;
      if (preferred > 0 && bound !== preferred) logger2.warn(`\u7AEF\u53E3 ${preferred} \u88AB\u5360\u7528\uFF0C\u6539\u7528 ${bound}`);
      return bound;
    } catch (error) {
      if (error.code !== "EADDRINUSE") throw error;
    }
  }
  throw new Error(`\u4ECE ${preferred} \u8D77\u8FDE\u7EED ${PORT_SCAN_LIMIT} \u4E2A\u7AEF\u53E3\u90FD\u88AB\u5360\u7528`);
}
async function listenStandaloneServer(options) {
  const security2 = options.security;
  const server2 = createServer(createRequestListener(options, security2));
  server2.requestTimeout = 1e4;
  server2.headersTimeout = 1e4;
  server2.on("clientError", (_error, socket) => socket.destroy());
  const port2 = await bindFirstFree(server2, options.port ?? DEFAULT_STANDALONE_PORT, options.logger);
  options.logger.info(`\u72EC\u7ACB\u6A21\u5F0F\u670D\u52A1\u5DF2\u76D1\u542C http://127.0.0.1:${port2}/`);
  return {
    port: port2,
    security: security2 ?? createRequestSecurity(),
    async close() {
      server2.closeAllConnections();
      await new Promise((accept) => server2.close(() => accept()));
    }
  };
}

// upstream/src/standalone/runtime-state.ts
import { mkdirSync as mkdirSync4, readFileSync as readFileSync4, unlinkSync as unlinkSync2 } from "node:fs";
import { join as join7 } from "node:path";

// upstream/src/standalone/ai-storage.ts
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync as existsSync6,
  fstatSync as fstatSync2,
  fsyncSync,
  lstatSync,
  mkdirSync as mkdirSync3,
  openSync,
  readFileSync as readFileSync3,
  renameSync as renameSync2,
  unlinkSync,
  writeFileSync as writeFileSync2,
  constants
} from "node:fs";
import { dirname as dirname3, join as join6 } from "node:path";
import { randomUUID } from "node:crypto";
function restrictFile(path) {
  if (process.platform !== "win32") {
    chmodSync(path, 384);
    return;
  }
  const identity = execFileSync(
    join6(process.env.SystemRoot ?? "C:\\Windows", "System32", "whoami.exe"),
    ["/user", "/fo", "csv", "/nh"],
    { encoding: "utf8", windowsHide: true }
  );
  const sid = identity.match(/\bS-1-\d+(?:-\d+)+\b/)?.[0];
  if (!sid) throw new Error("Cannot identify file owner");
  execFileSync(
    join6(process.env.SystemRoot ?? "C:\\Windows", "System32", "icacls.exe"),
    [path, "/inheritance:r", "/grant:r", `*${sid}:F`],
    { stdio: "pipe", windowsHide: true }
  );
}
function writePrivateJson(path, settings) {
  const directory = lstatSync(dirname3(path));
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error("Unsafe private file directory");
  if (existsSync6(path) && (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()))
    throw new Error("Unsafe settings file");
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 384);
  try {
    restrictFile(temporary);
    writeFileSync2(fd, JSON.stringify(settings), { encoding: "utf8" });
    fsyncSync(fd);
    closeSync(fd);
  } catch (error) {
    closeSync(fd);
    unlinkSync(temporary);
    throw error;
  }
  try {
    renameSync2(temporary, path);
  } catch (error) {
    unlinkSync(temporary);
    throw error;
  }
}

// upstream/src/standalone/runtime-state.ts
function writeStandaloneRuntime(home2, details) {
  const directory = join7(home2, "dsh-pet");
  mkdirSync4(directory, { recursive: true });
  const file = join7(directory, "standalone-runtime.json");
  try {
    writePrivateJson(file, {
      name: "dsh-pet-standalone",
      pid: process.pid,
      startedAt: (/* @__PURE__ */ new Date()).toISOString(),
      ...details
    });
  } catch (error) {
    throw new Error("\u65E0\u6CD5\u5B89\u5168\u5199\u5165\u684C\u5BA0\u8FD0\u884C\u72B6\u6001\uFF0C\u8BF7\u68C0\u67E5\u6570\u636E\u76EE\u5F55\u7684\u8BBF\u95EE\u6743\u9650\u3002", { cause: error });
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      const current = JSON.parse(readFileSync4(file, "utf8"));
      if (current.pid === process.pid && current.token === details.token) unlinkSync2(file);
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw new Error("\u6E05\u7406\u684C\u5BA0\u8FD0\u884C\u72B6\u6001\u5931\u8D25\uFF1B\u8BF7\u68C0\u67E5\u6570\u636E\u76EE\u5F55\uFF0C\u672A\u5220\u9664\u5176\u4ED6\u8FDB\u7A0B\u7684\u72B6\u6001\u3002", { cause: error });
    }
  };
}

// adapters/skin-store.ts
import { existsSync as existsSync7, mkdirSync as mkdirSync5, copyFileSync, cpSync, readFileSync as readFileSync5, writeFileSync as writeFileSync3, renameSync as renameSync3, readdirSync as readdirSync2, rmSync } from "node:fs";
import { join as join9 } from "node:path";

// upstream/src/standalone/options.ts
import { join as join8 } from "node:path";
var USAGE = `dsh-pet \u72EC\u7ACB\u6A21\u5F0F\uFF08\u4E0D\u9700\u8981 DSH\uFF09

\u7528\u6CD5\uFF1Adsh-pet-standalone [\u9009\u9879]

\u9009\u9879\uFF1A
  --port <\u7AEF\u53E3>   \u76D1\u542C\u7AEF\u53E3\uFF08\u9ED8\u8BA4 ${DEFAULT_STANDALONE_PORT}\uFF1B\u88AB\u5360\u7528\u65F6\u81EA\u52A8\u5411\u540E\u987A\u5EF6\uFF09
  --check         \u53EA\u4F53\u68C0\uFF1A\u6253\u5370\u914D\u7F6E\u6765\u6E90\u3001\u5BA0\u7269\u6E05\u5355\u4E0E Electron \u72B6\u6001\uFF0C\u4E0D\u542F\u52A8\u7A97\u53E3
  -h, --help      \u663E\u793A\u672C\u5E2E\u52A9

\u8BF4\u660E\uFF1A
  \u684C\u5BA0\u5728\u72EC\u7ACB\u6A21\u5F0F\u4E0B\u4EE5\u300C\u900F\u660E\u7F6E\u9876\u5C0F\u7A97\u300D\u8FD0\u884C\uFF1B\u6D4F\u89C8\u5668\u5185\u6D6E\u5C42\u9700\u8981\u6709 DSH \u7F51\u9875\uFF0C\u72EC\u7ACB\u6A21\u5F0F\u4E0D\u63D0\u4F9B\u3002
  \u5BF9\u8BDD\u4E0E\u788E\u788E\u5FF5\u53EF\u5728\u672C\u673A AI \u8BBE\u7F6E\u9875\u914D\u7F6E API \u540E\u663E\u5F0F\u542F\u7528\uFF1B\u672A\u914D\u7F6E\u65F6\u4E0D\u53D1\u9001\u6A21\u578B\u8BF7\u6C42\u3002
  \u4F59\u989D / DSH \u4F1A\u8BDD\u5DE5\u4F5C\u72B6\u6001 / \u7CFB\u7EDF\u901A\u77E5\u4ECD\u9700\u8981 DSH \u5BBF\u4E3B\u3002
`;
function configPathsFor(root, home2) {
  const userRoot = join8(home2, "dsh-pet");
  return {
    defaultFile: join8(root, "assets", "config.jsonc"),
    userFile: join8(userRoot, "main-config.jsonc"),
    legacyUserFile: join8(userRoot, "main-config.json"),
    petDir: join8(userRoot, "pet")
  };
}

// adapters/skin-store.ts
import { createHash } from "node:crypto";
function pruneBackups(dir, latest) {
  if (!readdirSync2(latest).length) {
    rmSync(latest, { recursive: true, force: true });
    return;
  }
  for (const name of readdirSync2(dir)) {
    const backup = join9(dir, name);
    if (backup === latest || !/^winter-\d+-\d+$/.test(name)) continue;
    try {
      rmSync(backup, { recursive: true, force: true });
    } catch (error) {
      console.error("[melo-pet-skins] old backup not removed:", backup, error.message);
    }
  }
}
function createSkinStore(packageRoot2, home2, packRoot) {
  const paths = configPathsFor(packageRoot2, home2);
  const root = join9(home2, "dsh-pet");
  const selectionFile = join9(root, "melo-skin.json");
  mkdirSync5(paths.petDir, { recursive: true });
  const winterFile = join9(paths.petDir, "winter-config.json");
  const packText = readFileSync5(join9(packRoot, "winter-config.json"), "utf8");
  const packManifest = readFileSync5(join9(packRoot, "manifest.json"), "utf8");
  const revision = createHash("sha256").update(packText).update(packManifest).digest("hex");
  const installedFile = join9(root, "winter-pack-revision.json");
  const animationDir = join9(paths.petDir, "winter-animation");
  const installed = existsSync7(installedFile) ? JSON.parse(readFileSync5(installedFile, "utf8")).revision : "";
  if (installed !== revision || !existsSync7(winterFile) || !existsSync7(animationDir)) {
    const pack = JSON.parse(packText);
    const existing = existsSync7(winterFile) ? JSON.parse(readFileSync5(winterFile, "utf8")) : {};
    const next = { ...pack, ...existing, animations: pack.animations, animationWeights: pack.animationWeights };
    const stamp = `${Date.now()}-${process.pid}`;
    const stage = join9(paths.petDir, ".winter-animation-next-" + stamp);
    const backup = join9(root, ".melo-backups", "winter-" + stamp);
    cpSync(join9(packRoot, "winter-animation"), stage, { recursive: true });
    writeFileSync3(winterFile + ".melo-next", JSON.stringify(next, null, 2), { mode: 384 });
    mkdirSync5(backup, { recursive: true });
    if (existsSync7(winterFile)) copyFileSync(winterFile, join9(backup, "winter-config.json"));
    if (existsSync7(animationDir)) renameSync3(animationDir, join9(backup, "winter-animation"));
    try {
      renameSync3(stage, animationDir);
      renameSync3(winterFile + ".melo-next", winterFile);
      writeFileSync3(installedFile + ".melo-next", JSON.stringify({ revision }), { mode: 384 });
      renameSync3(installedFile + ".melo-next", installedFile);
    } catch (error) {
      if (!existsSync7(animationDir) && existsSync7(join9(backup, "winter-animation"))) renameSync3(join9(backup, "winter-animation"), animationDir);
      throw error;
    }
    pruneBackups(join9(root, ".melo-backups"), backup);
  }
  let selected = existsSync7(selectionFile) ? JSON.parse(readFileSync5(selectionFile, "utf8")).skin : "main";
  if (!["main", "winter"].includes(selected)) throw new Error("\u76AE\u80A4\u9009\u62E9\u8BB0\u5F55\u65E0\u6548");
  function select(skin) {
    if (!["main", "winter"].includes(skin)) throw new Error("\u672A\u77E5\u76AE\u80A4");
    const merged = readAllConfig(paths);
    const mainExisting = readUserConfig(paths) ?? {};
    const winter = readPetConfigEntry(paths, "winter");
    if (!winter) throw new Error("\u91D1\u51AC\u5929\u76AE\u80A4\u914D\u7F6E\u7F3A\u5931");
    const mapPets = (pets) => pets.map((p) => ({ ...p, ...p.id === "main" ? { name: "\u5927\u80A5\u9C7C" } : {}, display: p.id === skin ? "desktop" : "none" }));
    const main = saveUserConfig({ pets: mapPets(merged.main.pets) }, mainExisting);
    const winterConfig = saveUserConfig({ pets: mapPets(merged.winter.pets) }, winter.raw);
    if (!main || !winterConfig) throw new Error("\u76AE\u80A4\u914D\u7F6E\u65E0\u6548");
    const writes = [
      [paths.userFile, JSON.stringify(main, null, 2)],
      [winter.path, JSON.stringify(winterConfig, null, 2)],
      [selectionFile, JSON.stringify({ skin }, null, 2)]
    ];
    for (const [file, data] of writes) writeFileSync3(file + ".melo-next", data, { mode: 384 });
    for (const [file] of writes) renameSync3(file + ".melo-next", file);
    selected = skin;
    return { skin, config: readAllConfig(paths) };
  }
  if (!existsSync7(paths.userFile)) {
    const defaults = readAllConfig(paths).main;
    const pets = defaults.pets.map((p) => ({ ...p, display: p.id === selected ? "desktop" : "none", balanceEnabled: false, whisperEnabled: false }));
    writeFileSync3(paths.userFile, JSON.stringify({ pets, notificationsEnabled: false, chatImageEnabled: false }, null, 2), { mode: 384 });
  }
  select(selected);
  return { select, get selected() {
    return selected;
  }, paths };
}

// adapters/host-entry.ts
var logger = createStandaloneLogger();
var home = dshHomeDir();
var skins = createSkinStore(packageRoot, home, join10(packageRoot, "..", "skins", "winter"));
var routes = [];
var port = { value: 0 };
var security = createRequestSecurity();
var context = createStandaloneContext({ port: () => port.value, routes, logger, authenticatedUrl: security.authenticatedUrl });
context.ctx.meloSelectSkin = (skin) => skins.select(skin);
context.ctx.meloBridge = {
  async send(text) {
    const base = process.env.MELO_PET_CONTROL_URL;
    const token = process.env.MELO_PET_CONTROL_TOKEN;
    if (!base || !token) throw new Error("Melo \u5BF9\u8BDD\u8FDE\u63A5\u5C1A\u672A\u542F\u52A8");
    const response = await fetch(base + "/chat", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + token },
      body: JSON.stringify({ text })
    });
    const result = await response.json();
    if (!response.ok || result.ok === false) throw new Error(result.error || "Melo \u5BF9\u8BDD\u8BF7\u6C42\u5931\u8D25");
    return result;
  }
};
var stop = () => {
};
var server = await listenStandaloneServer({
  routes,
  port: 0,
  logger,
  security,
  status: () => ({ name: "melo-desktop-pet-dsh", pid: process.pid, port: port.value, upstream: "PC2005-cloud/dsh-pet", skin: skins.selected }),
  onShutdown: () => stop()
});
port.value = server.port;
var release = writeStandaloneRuntime(home, { port: server.port, token: security.token, settingsUrl: security.authenticatedUrl("http://127.0.0.1:" + server.port), pluginRoot: packageRoot });
var stopping = false;
stop = () => {
  if (stopping) return;
  stopping = true;
  void context.dispose().finally(async () => {
    await server.close();
    release();
    process.exit(0);
  });
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
apply(context.ctx);
if (context.failures.length) throw new Error(context.failures.join("; "));
console.log("[melo-pet-host] " + JSON.stringify({ event: "ready", port: server.port, skin: skins.selected, packageRoot }));
