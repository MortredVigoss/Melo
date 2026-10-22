var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// adapters/skin-store.ts
var skin_store_exports = {};
__export(skin_store_exports, {
  createSkinStore: () => createSkinStore
});
module.exports = __toCommonJS(skin_store_exports);
var import_node_fs2 = require("node:fs");
var import_node_path3 = require("node:path");

// upstream/src/host/config.ts
var import_node_fs = require("node:fs");
var import_node_path = require("node:path");
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
    const raw = JSON.parse(stripJsonc((0, import_node_fs.readFileSync)(path, "utf8")));
    return raw && typeof raw === "object" ? raw : void 0;
  } catch {
    return void 0;
  }
}
function readUserConfig(paths) {
  const file = effectiveUserFile(paths);
  return file ? readJsonc(file) : void 0;
}
function effectiveUserFile(paths) {
  if ((0, import_node_fs.existsSync)(paths.userFile)) return paths.userFile;
  if (paths.legacyUserFile && (0, import_node_fs.existsSync)(paths.legacyUserFile)) return paths.legacyUserFile;
  return void 0;
}
function scanPetFiles(petDir) {
  let entries;
  try {
    entries = (0, import_node_fs.readdirSync)(petDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter((e) => e.isFile()).map((e) => e.name).filter((name) => /^.+?-config\.(json|jsonc)$/.test(name)).sort().map((name) => ({ prefix: name.replace(/-config\.(json|jsonc)$/, ""), path: (0, import_node_path.join)(petDir, name) }));
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

// upstream/src/standalone/options.ts
var import_node_path2 = require("node:path");

// upstream/src/standalone/request-body.ts
var MAX_REQUEST_BYTES = 1024 * 1024;
var MAX_SETTINGS_BYTES = 16 * 1024;

// upstream/src/standalone/settings.ts
var import_zod = require("zod");
var endpoint = import_zod.z.string().max(2048).refine((value) => {
  if (value === "") return true;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
}, "\u63A5\u53E3\u5730\u5740\u5FC5\u987B\u662F HTTP(S) \u5730\u5740\uFF0C\u4E14\u4E0D\u80FD\u542B\u8D26\u53F7\u3001\u67E5\u8BE2\u53C2\u6570\u6216\u7247\u6BB5");
var settingsSchema = import_zod.z.object({
  protocol: import_zod.z.enum(["openai-compatible", "anthropic"]).optional(),
  baseUrl: endpoint.optional(),
  model: import_zod.z.string().max(200).optional(),
  apiKey: import_zod.z.string().max(8192).optional(),
  clearApiKey: import_zod.z.boolean().optional(),
  enabled: import_zod.z.boolean().optional(),
  automaticWhispers: import_zod.z.boolean().optional(),
  whisperIntervalSec: import_zod.z.number().int().min(60).max(86400).optional(),
  maxTokens: import_zod.z.number().int().min(128).max(4096).optional(),
  timeoutMs: import_zod.z.number().int().min(1e3).max(6e4).optional()
}).strict();

// upstream/src/standalone/server.ts
var DEFAULT_STANDALONE_PORT = 3080;

// upstream/src/standalone/options.ts
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
function configPathsFor(root, home) {
  const userRoot = (0, import_node_path2.join)(home, "dsh-pet");
  return {
    defaultFile: (0, import_node_path2.join)(root, "assets", "config.jsonc"),
    userFile: (0, import_node_path2.join)(userRoot, "main-config.jsonc"),
    legacyUserFile: (0, import_node_path2.join)(userRoot, "main-config.json"),
    petDir: (0, import_node_path2.join)(userRoot, "pet")
  };
}

// adapters/skin-store.ts
var import_node_crypto = require("node:crypto");
function pruneBackups(dir, latest) {
  if (!(0, import_node_fs2.readdirSync)(latest).length) {
    (0, import_node_fs2.rmSync)(latest, { recursive: true, force: true });
    return;
  }
  for (const name of (0, import_node_fs2.readdirSync)(dir)) {
    const backup = (0, import_node_path3.join)(dir, name);
    if (backup === latest || !/^winter-\d+-\d+$/.test(name)) continue;
    try {
      (0, import_node_fs2.rmSync)(backup, { recursive: true, force: true });
    } catch (error) {
      console.error("[melo-pet-skins] old backup not removed:", backup, error.message);
    }
  }
}
function createSkinStore(packageRoot, home, packRoot) {
  const paths = configPathsFor(packageRoot, home);
  const root = (0, import_node_path3.join)(home, "dsh-pet");
  const selectionFile = (0, import_node_path3.join)(root, "melo-skin.json");
  (0, import_node_fs2.mkdirSync)(paths.petDir, { recursive: true });
  const winterFile = (0, import_node_path3.join)(paths.petDir, "winter-config.json");
  const packText = (0, import_node_fs2.readFileSync)((0, import_node_path3.join)(packRoot, "winter-config.json"), "utf8");
  const packManifest = (0, import_node_fs2.readFileSync)((0, import_node_path3.join)(packRoot, "manifest.json"), "utf8");
  const revision = (0, import_node_crypto.createHash)("sha256").update(packText).update(packManifest).digest("hex");
  const installedFile = (0, import_node_path3.join)(root, "winter-pack-revision.json");
  const animationDir = (0, import_node_path3.join)(paths.petDir, "winter-animation");
  const installed = (0, import_node_fs2.existsSync)(installedFile) ? JSON.parse((0, import_node_fs2.readFileSync)(installedFile, "utf8")).revision : "";
  if (installed !== revision || !(0, import_node_fs2.existsSync)(winterFile) || !(0, import_node_fs2.existsSync)(animationDir)) {
    const pack = JSON.parse(packText);
    const existing = (0, import_node_fs2.existsSync)(winterFile) ? JSON.parse((0, import_node_fs2.readFileSync)(winterFile, "utf8")) : {};
    const next = { ...pack, ...existing, animations: pack.animations, animationWeights: pack.animationWeights };
    const stamp = `${Date.now()}-${process.pid}`;
    const stage = (0, import_node_path3.join)(paths.petDir, ".winter-animation-next-" + stamp);
    const backup = (0, import_node_path3.join)(root, ".melo-backups", "winter-" + stamp);
    (0, import_node_fs2.cpSync)((0, import_node_path3.join)(packRoot, "winter-animation"), stage, { recursive: true });
    (0, import_node_fs2.writeFileSync)(winterFile + ".melo-next", JSON.stringify(next, null, 2), { mode: 384 });
    (0, import_node_fs2.mkdirSync)(backup, { recursive: true });
    if ((0, import_node_fs2.existsSync)(winterFile)) (0, import_node_fs2.copyFileSync)(winterFile, (0, import_node_path3.join)(backup, "winter-config.json"));
    if ((0, import_node_fs2.existsSync)(animationDir)) (0, import_node_fs2.renameSync)(animationDir, (0, import_node_path3.join)(backup, "winter-animation"));
    try {
      (0, import_node_fs2.renameSync)(stage, animationDir);
      (0, import_node_fs2.renameSync)(winterFile + ".melo-next", winterFile);
      (0, import_node_fs2.writeFileSync)(installedFile + ".melo-next", JSON.stringify({ revision }), { mode: 384 });
      (0, import_node_fs2.renameSync)(installedFile + ".melo-next", installedFile);
    } catch (error) {
      if (!(0, import_node_fs2.existsSync)(animationDir) && (0, import_node_fs2.existsSync)((0, import_node_path3.join)(backup, "winter-animation"))) (0, import_node_fs2.renameSync)((0, import_node_path3.join)(backup, "winter-animation"), animationDir);
      throw error;
    }
    pruneBackups((0, import_node_path3.join)(root, ".melo-backups"), backup);
  }
  let selected = (0, import_node_fs2.existsSync)(selectionFile) ? JSON.parse((0, import_node_fs2.readFileSync)(selectionFile, "utf8")).skin : "main";
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
    for (const [file, data] of writes) (0, import_node_fs2.writeFileSync)(file + ".melo-next", data, { mode: 384 });
    for (const [file] of writes) (0, import_node_fs2.renameSync)(file + ".melo-next", file);
    selected = skin;
    return { skin, config: readAllConfig(paths) };
  }
  if (!(0, import_node_fs2.existsSync)(paths.userFile)) {
    const defaults = readAllConfig(paths).main;
    const pets = defaults.pets.map((p) => ({ ...p, display: p.id === selected ? "desktop" : "none", balanceEnabled: false, whisperEnabled: false }));
    (0, import_node_fs2.writeFileSync)(paths.userFile, JSON.stringify({ pets, notificationsEnabled: false, chatImageEnabled: false }, null, 2), { mode: 384 });
  }
  select(selected);
  return { select, get selected() {
    return selected;
  }, paths };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  createSkinStore
});
