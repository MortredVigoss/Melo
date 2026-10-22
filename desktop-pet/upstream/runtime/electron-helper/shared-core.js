"use strict";
var PetShared = (() => {
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

  // upstream/src/shared/index.ts
  var index_exports = {};
  __export(index_exports, {
    ACCEL_GAIN_MAX: () => ACCEL_GAIN_MAX,
    ACCEL_REF: () => ACCEL_REF,
    ANIMATION_EXT: () => ANIMATION_EXT,
    BUBBLE_FONT_BASE_PX: () => BUBBLE_FONT_BASE_PX,
    BUBBLE_METRICS: () => BUBBLE_METRICS,
    BUBBLE_OVERLAP_RATIO: () => BUBBLE_OVERLAP_RATIO,
    CANVAS_H: () => CANVAS_H,
    CHAT_CSS: () => CHAT_CSS,
    DEAD_ZONE_SPEED: () => DEAD_ZONE_SPEED,
    DEFAULT_FONT: () => DEFAULT_FONT,
    DEFAULT_PHYSICS: () => DEFAULT_PHYSICS,
    DEFAULT_ROLLING_LABEL: () => DEFAULT_ROLLING_LABEL,
    DEFAULT_THROW_POWER: () => DEFAULT_THROW_POWER,
    DRAG_THRESHOLD: () => DRAG_THRESHOLD,
    FEET_Y: () => FEET_Y,
    FONT_PRESETS: () => FONT_PRESETS,
    FONT_REF_SIZE: () => FONT_REF_SIZE,
    FONT_SIZE_MAX: () => FONT_SIZE_MAX,
    FONT_SIZE_MIN: () => FONT_SIZE_MIN,
    GRAVITY: () => GRAVITY,
    GROUND_FRICTION: () => GROUND_FRICTION,
    HIT_BOX: () => HIT_BOX,
    MAX_BODY: () => MAX_BODY,
    MAX_STEP_DT: () => MAX_STEP_DT,
    MAX_THROW_SPEED: () => MAX_THROW_SPEED,
    MEME_BUBBLE_CLASS: () => MEME_BUBBLE_CLASS,
    MEME_BUBBLE_CSS: () => MEME_BUBBLE_CSS,
    MEME_IMG_CLASS: () => MEME_IMG_CLASS,
    MENU_CSS: () => MENU_CSS,
    MIN_SPAN_MS: () => MIN_SPAN_MS,
    MORE_MENU_LABEL: () => MORE_MENU_LABEL,
    NOTIFY_ICONS: () => NOTIFY_ICONS,
    PEAK_WEIGHT: () => PEAK_WEIGHT,
    PET_BOUNCE_E: () => PET_BOUNCE_E,
    PET_DISPLAYS: () => PET_DISPLAYS,
    PET_REF_WIDTH: () => PET_REF_WIDTH,
    QUOTA_CRIT_PERCENT: () => QUOTA_CRIT_PERCENT,
    QUOTA_WARN_PERCENT: () => QUOTA_WARN_PERCENT,
    RELEASE_STALE_MS: () => RELEASE_STALE_MS,
    RELEASE_WINDOW_MS: () => RELEASE_WINDOW_MS,
    RESTITUTION: () => RESTITUTION,
    REST_VX: () => REST_VX,
    REST_VY: () => REST_VY,
    SCORE_MIN_SPEED: () => SCORE_MIN_SPEED,
    SCORE_POPUP_CSS: () => SCORE_POPUP_CSS,
    SCORE_POPUP_DURATION_MS: () => SCORE_POPUP_DURATION_MS,
    SEG_MIN_DT_MS: () => SEG_MIN_DT_MS,
    SPRING_C: () => SPRING_C,
    SPRING_K: () => SPRING_K,
    SQ_DURATION_MS: () => SQ_DURATION_MS,
    SQ_HARD_SPEED: () => SQ_HARD_SPEED,
    SQ_MAX_SQUASH: () => SQ_MAX_SQUASH,
    SQ_SOFT_SPEED: () => SQ_SOFT_SPEED,
    SQ_SQUASH: () => SQ_SQUASH,
    THROW_SPEED_ANCHOR: () => THROW_SPEED_ANCHOR,
    TIP_FONT_BASE_PX: () => TIP_FONT_BASE_PX,
    TOOLTIP_CLASS: () => TOOLTIP_CLASS,
    TOOLTIP_CSS: () => TOOLTIP_CSS,
    TOOLTIP_GAP_RATIO: () => TOOLTIP_GAP_RATIO,
    TRAIL_KEEP_MS: () => TRAIL_KEEP_MS,
    WINDOW_LABELS: () => WINDOW_LABELS,
    WORK_STATUS_INDEX: () => WORK_STATUS_INDEX,
    WORK_STATUS_STATES: () => WORK_STATUS_STATES,
    anchorPixel: () => anchorPixel,
    balanceBubbleView: () => balanceBubbleView,
    balanceDetailView: () => balanceDetailView,
    balanceEventIndex: () => balanceEventIndex,
    balancePercent: () => balancePercent,
    bodyPixelBox: () => bodyPixelBox,
    boundingRect: () => boundingRect,
    bubbleMaxHeightPx: () => bubbleMaxHeightPx,
    bubbleTopMarginPx: () => bubbleTopMarginPx,
    buildMenuTree: () => buildMenuTree,
    buildMoreBranch: () => buildMoreBranch,
    clampPointInRect: () => clampPointInRect,
    clampPointToRegion: () => clampPointToRegion,
    clickScore: () => clickScore,
    collidePet: () => collidePet,
    createMemeImage: () => createMemeImage,
    createMemeImageFromUrl: () => createMemeImageFromUrl,
    decideBalanceNotice: () => decideBalanceNotice,
    displayMenuBranch: () => displayMenuBranch,
    distToRectSq: () => distToRectSq,
    estimateReleaseVelocity: () => estimateReleaseVelocity,
    fetchState: () => fetchState,
    flattenConfigPets: () => flattenConfigPets,
    flattenCounters: () => flattenCounters,
    fontStackOf: () => fontStackOf,
    frameToToast: () => frameToToast,
    indexAtPoint: () => indexAtPoint,
    injectMemeBubbleCss: () => injectMemeBubbleCss,
    isDesktopVisible: () => isDesktopVisible,
    isEventAnim: () => isEventAnim,
    isNoMirrorAnimation: () => isNoMirrorAnimation,
    isWebVisible: () => isWebVisible,
    landingSquash: () => landingSquash,
    memeImageUrl: () => memeImageUrl,
    mountChatDialog: () => mountChatDialog,
    mountContextMenu: () => mountContextMenu,
    mountScorePopup: () => mountScorePopup,
    nearestIndex: () => nearestIndex,
    nextWorkStatusAnim: () => nextWorkStatusAnim,
    pick: () => pick,
    pickCategoryAction: () => pickCategoryAction,
    pickSlot: () => pickSlot,
    pickWeightedCategory: () => pickWeightedCategory,
    planMove: () => planMove,
    pointInRect: () => pointInRect,
    poolIncludes: () => poolIncludes,
    postAction: () => postAction,
    quotaTone: () => quotaTone,
    randomBetween: () => randomBetween,
    readAnim: () => readAnim,
    readBalance: () => readBalance,
    readLock: () => readLock,
    readMenuItems: () => readMenuItems,
    readPosition: () => readPosition,
    readSay: () => readSay,
    readThrow: () => readThrow,
    readWorkStatus: () => readWorkStatus,
    rectAtPoint: () => rectAtPoint,
    rectBottom: () => rectBottom,
    rectRight: () => rectRight,
    rectsOverlap: () => rectsOverlap,
    regionArea: () => regionArea,
    regionHoleRatio: () => regionHoleRatio,
    resetInText: () => resetInText,
    resolveFontPx: () => resolveFontPx,
    resolveRect: () => resolveRect,
    rollKind: () => rollKind,
    screenOfBox: () => screenOfBox,
    sendChat: () => sendChat,
    slotIncludes: () => slotIncludes,
    softClampSpeed: () => softClampSpeed,
    spawnScoreBurst: () => spawnScoreBurst,
    springStep: () => springStep,
    squashScale: () => squashScale,
    takeChanged: () => takeChanged,
    throwBounds: () => throwBounds,
    throwBoundsIn: () => throwBoundsIn,
    throwSpace: () => throwSpace,
    throwStep: () => throwStep,
    throwStepRegion: () => throwStepRegion,
    throwVelocity: () => throwVelocity,
    toBalanceState: () => toBalanceState,
    toWorkStatus: () => toWorkStatus,
    tooltipPlacement: () => tooltipPlacement,
    translateRects: () => translateRects,
    trimTrail: () => trimTrail,
    truncate: () => truncate,
    urgentWindow: () => urgentWindow,
    whisperBubbleView: () => whisperBubbleView
  });

  // upstream/src/shared/constants.ts
  var CANVAS_H = 360;
  var FEET_Y = 330;
  var HIT_BOX = { x0: 200, y0: 50, x1: 440, y1: 335 };
  var DRAG_THRESHOLD = 5;
  var PET_REF_WIDTH = 462;
  var ANIMATION_EXT = ".webm";

  // upstream/src/shared/pickers.ts
  var pick = (pool, exclude) => {
    const entries = exclude ? pool.filter((n) => n !== exclude) : pool;
    const src = entries.length ? entries : pool;
    return src[Math.floor(Math.random() * src.length)];
  };
  var pickSlot = (slot, exclude) => {
    if (typeof slot === "string") return slot;
    const entries = exclude === void 0 ? slot : slot.filter((n) => n !== exclude);
    const src = entries.length ? entries : slot;
    return src[Math.floor(Math.random() * src.length)];
  };
  var slotIncludes = (slot, anim) => typeof slot === "string" ? slot === anim : slot.includes(anim);
  var poolIncludes = (pool, anim) => pool.some((slot) => slotIncludes(slot, anim));
  var isEventAnim = (events, anim) => events ? Object.values(events).some((pool) => poolIncludes(pool, anim)) : false;
  var nextWorkStatusAnim = (pool, current) => {
    const idx = pool.findIndex((slot2) => slotIncludes(slot2, current));
    if (idx === -1) return null;
    const slot = pool[idx];
    if (!Array.isArray(slot) || slot.length <= 1) return null;
    return pickSlot(slot, current);
  };
  var randomBetween = (min, max) => Math.floor(min + Math.random() * (max - min));
  var pickWeightedCategory = (categories, facing) => {
    const cats = categories.filter((c) => c.actions.length > 0);
    if (!cats.length) return null;
    const filtered = cats.filter((c) => !(c.noMirror && facing === "right"));
    const eligible = filtered.length ? filtered : cats;
    const totalW = eligible.reduce((s, c) => s + c.weight, 0) || 1;
    let t = Math.random() * totalW;
    for (const c of eligible) {
      t -= c.weight;
      if (t <= 0) return c;
    }
    return eligible[eligible.length - 1];
  };
  var rollKind = (roll, w, opts) => {
    const turn = opts?.fixed ? 0 : w.turn;
    const move = opts?.fixed ? 0 : w.move;
    const topEnd = (w.idle + turn + move) / 100;
    if (roll < w.idle / 100) return "idle";
    if (roll < (w.idle + turn) / 100) return "turn";
    if (roll < topEnd) return "move";
    return "action";
  };
  var pickCategoryAction = (categories, idlePool, facing, current) => {
    const cat = pickWeightedCategory(categories, facing);
    if (!cat) return { id: "FALLBACK", name: pick(idlePool, current) };
    return { id: cat.id, name: pick(cat.actions, current) };
  };

  // upstream/src/shared/displays.ts
  var rectRight = (r) => r.x + r.width;
  var rectBottom = (r) => r.y + r.height;
  var boundingRect = (rects) => {
    if (rects.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const r of rects) {
      x0 = Math.min(x0, r.x);
      y0 = Math.min(y0, r.y);
      x1 = Math.max(x1, rectRight(r));
      y1 = Math.max(y1, rectBottom(r));
    }
    return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
  };
  var pointInRect = (r, x, y) => x >= r.x && x < rectRight(r) && y >= r.y && y < rectBottom(r);
  var rectAtPoint = (rects, x, y) => {
    for (const r of rects) if (pointInRect(r, x, y)) return r;
    return null;
  };
  var indexAtPoint = (rects, x, y) => {
    for (let i = 0; i < rects.length; i++) if (pointInRect(rects[i], x, y)) return i;
    return -1;
  };
  var distToRectSq = (r, x, y) => {
    const dx = Math.max(r.x - x, 0, x - rectRight(r));
    const dy = Math.max(r.y - y, 0, y - rectBottom(r));
    return dx * dx + dy * dy;
  };
  var nearestIndex = (rects, x, y) => {
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < rects.length; i++) {
      const d = distToRectSq(rects[i], x, y);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  };
  var resolveRect = (rects, x, y) => {
    const hit = rectAtPoint(rects, x, y);
    if (hit) return hit;
    const i = nearestIndex(rects, x, y);
    return i < 0 ? null : rects[i];
  };
  var clampPointInRect = (r, x, y) => ({
    x: Math.min(Math.max(x, r.x), rectRight(r) - 1),
    y: Math.min(Math.max(y, r.y), rectBottom(r) - 1)
  });
  var clampPointToRegion = (rects, x, y) => {
    if (rectAtPoint(rects, x, y)) return { x, y };
    const i = nearestIndex(rects, x, y);
    return i < 0 ? { x, y } : clampPointInRect(rects[i], x, y);
  };
  var regionArea = (rects) => rects.reduce((s, r) => s + r.width * r.height, 0);
  var regionHoleRatio = (rects) => {
    const hull = boundingRect(rects);
    const hullArea = hull.width * hull.height;
    if (hullArea <= 0) return 0;
    return Math.max(0, 1 - regionArea(rects) / hullArea);
  };
  var translateRects = (rects, dx, dy) => rects.map((r) => ({ x: r.x + dx, y: r.y + dy, width: r.width, height: r.height }));

  // upstream/src/shared/motion.ts
  var planMove = (o) => {
    const side = o.sideAllow ?? 0;
    const distance = randomBetween(o.minDist, o.maxDist);
    const target = o.cx + o.dir * distance;
    if (o.areas && o.areas.length > 0) {
      const bodyHalf = o.halfW - side;
      if (!rectAtPoint(o.areas, target - bodyHalf - o.margin, o.cy)) return null;
      if (!rectAtPoint(o.areas, target + bodyHalf + o.margin, o.cy)) return null;
    } else {
      const leftBound = o.margin + o.halfW - side;
      const rightBound = o.W - o.margin - o.halfW + side;
      if (target < leftBound || target > rightBound) return null;
    }
    return {
      startRatio: o.cx / o.W,
      startYRatio: o.cy / o.H,
      targetRatio: target / o.W,
      totalRatio: Math.abs(target - o.cx) / o.W
    };
  };
  var anchorPixel = (o) => {
    const height = o.size * 9 / 16;
    const a = o.area ?? { x: 0, y: 0, width: o.W, height: o.H };
    const left = a.x + o.marginX;
    const top = a.y + o.marginY;
    const right = a.x + a.width - o.size - o.marginX;
    const bottom = a.y + a.height - height - o.marginY;
    switch (o.corner) {
      case "top-left":
        return { x: left, y: top };
      case "top-right":
        return { x: right, y: top };
      case "bottom-left":
        return { x: left, y: bottom };
      case "bottom-right":
        return { x: right, y: bottom };
    }
  };

  // upstream/src/shared/balance.ts
  function optNum(value) {
    if (value === void 0 || value === null) return void 0;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  function toBalanceState(raw) {
    if (!raw || typeof raw !== "object") return null;
    const r = raw;
    const provider = String(r.provider ?? "unknown");
    if (r.ok !== true) {
      const reason = r.reason === "unsupported" || r.reason === "credential-missing" || r.reason === "fetch-error" ? r.reason : "fetch-error";
      return { provider, ok: false, reason, message: typeof r.message === "string" ? r.message : void 0 };
    }
    const d = r.data;
    if (!d || typeof d !== "object") return null;
    if (r.shape === "windows") {
      const monthly = optNum(d.monthly);
      const rolling = optNum(d.rolling);
      const weekly = optNum(d.weekly);
      const rollingCapUsd = optNum(d.rollingCapUsd);
      const weeklyCapUsd = optNum(d.weeklyCapUsd);
      const monthlyCapUsd = optNum(d.monthlyCapUsd);
      if (monthly === void 0 || monthly === null) return null;
      if (rolling === null || weekly === null || rollingCapUsd === null || weeklyCapUsd === null || monthlyCapUsd === null) {
        return null;
      }
      return {
        provider,
        shape: "windows",
        ok: true,
        rolling,
        weekly,
        monthly,
        rollingCapUsd,
        weeklyCapUsd,
        monthlyCapUsd,
        rollingLabel: typeof d.rollingLabel === "string" && d.rollingLabel.length > 0 ? d.rollingLabel : void 0,
        rollingResetsAt: typeof d.rollingResetsAt === "string" ? d.rollingResetsAt : void 0,
        weeklyResetsAt: typeof d.weeklyResetsAt === "string" ? d.weeklyResetsAt : void 0,
        monthlyResetsAt: typeof d.monthlyResetsAt === "string" ? d.monthlyResetsAt : void 0
      };
    }
    if (r.shape === "money") {
      const raw2 = Array.isArray(d.wallets) ? d.wallets : [];
      const wallets = [];
      for (const item of raw2) {
        if (!item || typeof item !== "object") continue;
        const w = item;
        if (typeof w.currency !== "string" || w.currency.length === 0) continue;
        if (typeof w.total !== "string" || w.total.length === 0) continue;
        wallets.push({
          currency: w.currency,
          total: w.total,
          granted: typeof w.granted === "string" && w.granted.length > 0 ? w.granted : "0.00",
          toppedUp: typeof w.toppedUp === "string" && w.toppedUp.length > 0 ? w.toppedUp : "0.00",
          fullBalance: typeof w.fullBalance === "string" && w.fullBalance.length > 0 ? w.fullBalance : void 0
        });
      }
      if (wallets.length === 0) return null;
      return {
        provider,
        shape: "money",
        ok: true,
        wallets,
        tier: d.tier === "peak" || d.tier === "idle" ? d.tier : void 0
      };
    }
    return null;
  }
  function balancePercent(v) {
    if (v.shape === "money") {
      let remaining = 0;
      let based = 0;
      for (const w of v.wallets ?? []) {
        const total = Number(w.total);
        const full = Number(w.fullBalance);
        if (!Number.isFinite(total) || !Number.isFinite(full) || full <= 0) continue;
        remaining += total / full;
        based++;
      }
      if (based === 0) return void 0;
      return Math.max(0, Math.min(100, 100 - remaining * 100));
    }
    return Math.max(v.rolling ?? 0, v.weekly ?? 0, v.monthly ?? 0);
  }
  function balanceEventIndex(p) {
    if (p === 100) return 5;
    const i = Math.floor(p / 20);
    return i < 5 ? i : 4;
  }
  var WINDOW_LABELS = {
    weekly: "\u5468",
    monthly: "\u6708"
  };
  var DEFAULT_ROLLING_LABEL = "5h";
  function windowLabel(v, w) {
    if (w === "rolling") return v.rollingLabel ?? DEFAULT_ROLLING_LABEL;
    return WINDOW_LABELS[w];
  }
  function windowQuotas(v) {
    return { rolling: v.rollingCapUsd, weekly: v.weeklyCapUsd, monthly: v.monthlyCapUsd };
  }
  function urgentWindow(v) {
    if (v.shape === "money") return void 0;
    const quotas = windowQuotas(v);
    const resets = {
      rolling: v.rollingResetsAt,
      weekly: v.weeklyResetsAt,
      monthly: v.monthlyResetsAt
    };
    const present = ["rolling", "weekly", "monthly"].filter((w) => v[w] !== void 0);
    if (present.length === 0) return void 0;
    const allQuotas = present.every((w) => {
      const quota = quotas[w];
      return quota !== void 0 && quota > 0;
    });
    let best;
    for (const w of present) {
      const percent = v[w] ?? 0;
      const quota = quotas[w];
      const cand = {
        label: windowLabel(v, w),
        percent,
        quotaUsd: quota,
        remainingUsd: allQuotas && quota !== void 0 ? quota * (100 - percent) / 100 : void 0,
        resetsAt: resets[w]
      };
      if (best === void 0) {
        best = cand;
        continue;
      }
      const moreUrgent = allQuotas ? (cand.remainingUsd ?? 0) < (best.remainingUsd ?? 0) : cand.percent > best.percent;
      if (moreUrgent) best = cand;
    }
    return best;
  }
  function resetInText(iso) {
    if (!iso) return "";
    const t = new Date(iso).getTime();
    if (!Number.isFinite(t)) return "";
    const delta = t - Date.now();
    if (delta <= 0) return "\u5DF2\u91CD\u7F6E";
    const hoursF = delta / 36e5;
    if (hoursF >= 96) return (Math.round(hoursF / 24 * 10) / 10).toFixed(1) + " \u5929";
    return Math.max(0.1, Math.round(hoursF * 10) / 10).toFixed(1) + " \u5C0F\u65F6";
  }
  var QUOTA_WARN_PERCENT = 70;
  var QUOTA_CRIT_PERCENT = 90;
  function quotaTone(percent) {
    if (percent >= QUOTA_CRIT_PERCENT) return "crit";
    if (percent >= QUOTA_WARN_PERCENT) return "warn";
    return "ok";
  }
  function unavailableRows(state) {
    const rows = state.reason === "unsupported" ? [
      { role: "error", text: "\u5F53\u524D\u670D\u52A1\u5546\u6682\u4E0D\u652F\u6301\u4F59\u989D\u67E5\u8BE2" },
      { role: "sub", text: "\u5F53\u524D\u670D\u52A1\u5546\uFF1A" + state.provider }
    ] : state.reason === "credential-missing" ? [
      // host 的 message 本身已带「缺少凭证 X」前缀：这里只作次要行原样展示，不再加前缀
      // （曾经的「缺少凭证：缺少凭证 X」双重前缀）
      { role: "error", text: "\u7F3A\u5C11\u4F59\u989D\u67E5\u8BE2\u51ED\u8BC1" },
      { role: "sub", text: state.message ?? "" }
    ] : [
      { role: "error", text: "\u4F59\u989D\u67E5\u8BE2\u5931\u8D25" },
      { role: "sub", text: state.message ?? "" }
    ];
    return rows.filter((r) => r.role !== "quota" && r.text !== "");
  }
  function balanceBubbleView(state) {
    if (state.ok) {
      if (state.shape !== "money") {
        const w = urgentWindow(state);
        if (w) {
          const reset = resetInText(w.resetsAt);
          const rows = [
            { role: "label", text: w.label + "\u989D\u5EA6\u5DF2\u7528 " + Math.round(w.percent) + "%" },
            { role: "sub", text: reset ? reset + "\u91CD\u7F6E" : "\u5DF2\u91CD\u7F6E" }
          ];
          return rows;
        }
        return [{ role: "label", text: "\u989D\u5EA6\u6570\u636E\u4E0D\u53EF\u7528" }];
      }
      const visible = (state.wallets ?? []).filter((w) => Number(w.total) !== 0).sort((a, b) => (a.currency === "CNY" ? 0 : 1) - (b.currency === "CNY" ? 0 : 1));
      const amount = visible.length > 0 ? visible.map((w) => (w.currency === "USD" ? "$" : "\xA5") + w.total).join("/") : "\xA50.00";
      if (!state.tier) return [{ role: "label", text: "\u4F59\u989D " + amount }];
      return [
        { role: "label", text: "\u4F59\u989D\uFF08" },
        { role: "tier", tier: state.tier, text: state.tier === "peak" ? "\u5CF0" : "\u8C37" },
        { role: "label", text: "\uFF09" + amount }
      ];
    }
    return unavailableRows(state);
  }
  function balanceDetailView(state) {
    if (!state.ok) return unavailableRows(state);
    if (state.shape === "money") return balanceBubbleView(state);
    const resets = {
      rolling: state.rollingResetsAt,
      weekly: state.weeklyResetsAt,
      monthly: state.monthlyResetsAt
    };
    const rows = [];
    for (const w of ["rolling", "weekly", "monthly"]) {
      const percent = state[w];
      if (percent === void 0) continue;
      const reset = resetInText(resets[w]);
      const usedText = Math.round(percent) + "%";
      const resetText = reset === "" ? "\u5DF2\u91CD\u7F6E" : reset + "\u91CD\u7F6E";
      rows.push({
        role: "quota",
        text: windowLabel(state, w) + " " + usedText + " " + resetText,
        label: windowLabel(state, w),
        percent,
        tone: quotaTone(percent),
        usedText,
        resetText
      });
    }
    return rows.length > 0 ? rows : balanceBubbleView(state);
  }
  function decideBalanceNotice(state, lastKey, explicit) {
    if (state.ok) return { show: false, key: null };
    const key = state.reason + ":" + state.provider;
    return { show: explicit || key !== lastKey, key };
  }

  // upstream/src/shared/whisper.ts
  function whisperBubbleView(state) {
    if (state.ok) return [{ role: "label", text: state.text }];
    const msg = state.reason === "provider-missing" ? "\u5F53\u524D\u5BF9\u8BDD\u672A\u914D\u7F6E\u6A21\u578B\uFF0C\u788E\u788E\u5FF5\u4E0D\u53EF\u7528" : "\u788E\u788E\u5FF5\u751F\u6210\u5931\u8D25" + (state.message ? "\uFF1A" + state.message : "");
    return [{ role: "label", text: msg }];
  }
  function memeImageUrl(name, base = "/dsh-pet-7340", assetRoot = "") {
    const root = String(assetRoot ?? "").trim();
    const prefix = root ? "/pic/memes/" + encodeURIComponent(root) : "/pic/memes";
    return base + prefix + "/" + encodeURIComponent(name) + ".png";
  }
  var MEME_IMG_CLASS = "pet-bub-img";
  var MEME_BUBBLE_CLASS = "has-img";
  var MEME_BUBBLE_CSS = [
    ".pet-bub-img{--m:var(--f,calc(var(--dsh-pet-size,var(--pet-size,462px))*0.0455));display:block;width:calc(var(--m)*7.4725);max-width:100%;height:auto;border-radius:calc(var(--m)*0.5714);margin:0 auto calc(var(--m)*0.3736);object-fit:cover;pointer-events:none;user-select:none}",
    ".pet-bubble.has-img,.dsh-pet-bubble.has-img{min-width:0}"
  ].join("");
  var memeCssInjected = false;
  function injectMemeBubbleCss() {
    if (memeCssInjected || typeof document === "undefined") return;
    memeCssInjected = true;
    if (document.querySelector('style[data-plugin-css="dsh-pet/meme-bubble"]') !== null) return;
    const tag = document.createElement("style");
    tag.dataset.plugin = "dsh-pet";
    tag.dataset.pluginCss = "dsh-pet/meme-bubble";
    tag.textContent = MEME_BUBBLE_CSS;
    document.head.appendChild(tag);
  }
  function createMemeImage(name, base = "/dsh-pet-7340", assetRoot = "") {
    const key = String(name ?? "").trim();
    if (!key) return null;
    injectMemeBubbleCss();
    const img = document.createElement("img");
    img.className = MEME_IMG_CLASS;
    img.src = memeImageUrl(key, base, assetRoot);
    img.alt = key;
    return img;
  }
  function createMemeImageFromUrl(url) {
    const href = String(url ?? "").trim();
    if (!href) return null;
    injectMemeBubbleCss();
    const img = document.createElement("img");
    img.className = MEME_IMG_CLASS;
    img.src = href;
    img.alt = "";
    return img;
  }

  // upstream/src/shared/config.ts
  var PET_DISPLAYS = ["web", "desktop", "both", "none"];
  var isWebVisible = (display) => display === "web" || display === "both";
  var isDesktopVisible = (display) => display === "desktop" || display === "both";
  function flattenConfigPets(merged) {
    const out = [];
    for (const [entry, conf] of Object.entries(merged)) {
      const list = Array.isArray(conf?.pets) ? conf.pets : [];
      for (const p of list) {
        out.push({
          ...p,
          animations: conf.animations,
          animationWeights: conf.animationWeights,
          eventsRefreshSec: conf.eventsRefreshSec,
          physics: conf.physics,
          font: conf.font,
          confineToScreen: conf.confineToScreen,
          workStatusTexts: conf.workStatusTexts,
          whisperModel: conf.whisperModel,
          chatModel: conf.chatModel,
          assetRoot: entry,
          extra: entry !== "main"
        });
      }
    }
    return out;
  }

  // upstream/src/shared/fonts.ts
  var FONT_PRESETS = [
    {
      id: "candy",
      stack: '"ShangshouSoftCandy","Yuanti SC","YouYuan","\u5E7C\u5706","Comic Sans MS","PingFang SC","Microsoft YaHei",sans-serif'
    },
    { id: "yahei", stack: '"Microsoft YaHei","PingFang SC",sans-serif' },
    { id: "youyuan", stack: '"YouYuan","Yuanti SC",sans-serif' },
    { id: "kaiti", stack: '"KaiTi","STKaiti",serif' },
    { id: "simsun", stack: '"SimSun","Songti SC",serif' },
    { id: "comic", stack: '"Comic Sans MS","Comic Sans",cursive' },
    { id: "system", stack: "system-ui,sans-serif" }
  ];
  var FONT_SIZE_MIN = 4;
  var FONT_SIZE_MAX = 200;
  var DEFAULT_FONT = {
    family: "candy",
    size: 21,
    followPet: true
  };
  function fontStackOf(id) {
    return (FONT_PRESETS.find((p) => p.id === id) ?? FONT_PRESETS[0]).stack;
  }
  var FONT_REF_SIZE = 462;
  var BUBBLE_FONT_BASE_PX = 0.0455 * FONT_REF_SIZE;
  var TIP_FONT_BASE_PX = 0.026 * FONT_REF_SIZE;
  function resolveFontPx(font, size) {
    const own = Number(font?.size);
    const ratio = Number.isFinite(own) && own > 0 ? own / DEFAULT_FONT.size : 1;
    const w = Number(size);
    const follow = font?.followPet !== false;
    const scale = follow && Number.isFinite(w) && w > 0 ? w / FONT_REF_SIZE : 1;
    return {
      bubble: BUBBLE_FONT_BASE_PX * ratio * scale,
      tip: TIP_FONT_BASE_PX * ratio * scale
    };
  }
  var BUBBLE_OVERLAP_RATIO = 0.108;
  var BUBBLE_METRICS = {
    lineHeight: 1.6,
    padY: 0.4835,
    subScale: 0.7692,
    imgWidth: 7.4725,
    imgMargin: 0.3736,
    /** 配图长宽比上限（内置 assets/memes 全为 128 宽、高 ≤ 128，即 ≤ 1.0） */
    imgMaxRatio: 1
  };
  function bubbleMaxHeightPx(font, size) {
    const f = resolveFontPx(font, size).bubble;
    const m = BUBBLE_METRICS;
    return m.padY * 2 * f + // 内边距上下
    m.lineHeight * f + // 主行
    m.lineHeight * m.subScale * f + // 次要行（字号 0.7692）
    m.imgWidth * m.imgMaxRatio * f + // 配图（宽 × 比例上限）
    m.imgMargin * f;
  }
  function bubbleTopMarginPx(font, size) {
    const overlap = (Number(size) || 0) * BUBBLE_OVERLAP_RATIO;
    return Math.max(0, Math.ceil(bubbleMaxHeightPx(font, size) - overlap));
  }

  // upstream/src/shared/notify.ts
  var NOTIFY_ICONS = {
    done: "notify-done",
    error: "notify-error",
    truncated: "notify-truncated",
    approval: "notify-approval",
    question: "notify-question",
    test: "notify-test"
  };
  var MAX_BODY = 80;
  function truncate(text) {
    return text.length > MAX_BODY ? text.slice(0, MAX_BODY) + "\u2026" : text;
  }
  function frameToToast(frame) {
    switch (frame.type) {
      case "session/event": {
        const ev = frame.event ?? {};
        if (ev.type !== "turn/end") return null;
        const kind = ev.data?.reason?.kind;
        if (kind === "completed") return { title: "\u5BF9\u8BDD\u5B8C\u6210", body: "", icon: NOTIFY_ICONS.done };
        if (kind === "error")
          return { title: "\u751F\u6210\u5931\u8D25", body: ev.data?.reason?.error?.message ?? "", icon: NOTIFY_ICONS.error };
        if (kind === "max-tokens")
          return { title: "\u8F93\u51FA\u88AB\u622A\u65AD", body: "\u5DF2\u8FBE\u5230\u8F93\u51FA token \u4E0A\u9650", icon: NOTIFY_ICONS.truncated };
        return null;
      }
      case "approval/requested": {
        const toolName = typeof frame.toolName === "string" ? frame.toolName : "";
        const reason = typeof frame.reason === "string" && frame.reason ? frame.reason : "";
        return {
          title: "\u6B63\u5728\u7533\u8BF7\u6743\u9650",
          body: (toolName ? "\u5DE5\u5177\u300C" + toolName + "\u300D" : "") + (reason ? "\uFF1A" + reason : ""),
          icon: NOTIFY_ICONS.approval
        };
      }
      case "question/requested": {
        const q = Array.isArray(frame.questions) && frame.questions[0]?.question || "";
        return { title: "\u6A21\u578B\u5728\u7B49\u4F60\u56DE\u7B54", body: q, icon: NOTIFY_ICONS.question };
      }
      case "host/agent-error": {
        return {
          title: "\u751F\u6210\u5931\u8D25",
          body: typeof frame.message === "string" ? frame.message : "",
          icon: NOTIFY_ICONS.error
        };
      }
      default:
        return null;
    }
  }

  // upstream/src/shared/menu.ts
  var displayMenuBranch = () => ({
    label: "\u663E\u793A\u4F4D\u7F6E",
    children: [
      { label: "\u4EC5\u7F51\u9875", action: "set-display", display: "web" },
      { label: "\u4EC5\u684C\u9762", action: "set-display", display: "desktop" },
      { label: "\u4E24\u8005", action: "set-display", display: "both" },
      { label: "\u90FD\u4E0D", action: "set-display", display: "none" }
    ]
  });
  var MORE_MENU_LABEL = "\u66F4\u591A";
  function readMenuItems(data) {
    if (!data || typeof data !== "object") return [];
    const items = data.items;
    if (!Array.isArray(items)) return [];
    const out = [];
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      const owner = item.owner;
      const label = item.label;
      if (typeof owner === "string" && owner !== "" && typeof label === "string" && label !== "") {
        out.push({ owner, label });
      }
    }
    return out;
  }
  function buildMoreBranch(items) {
    const groups = /* @__PURE__ */ new Map();
    for (const item of items) {
      const list = groups.get(item.owner);
      if (list) list.push(item.label);
      else groups.set(item.owner, [item.label]);
    }
    const children = [];
    for (const [owner, labels] of groups) {
      if (labels.length === 1) {
        children.push({ label: labels[0], action: "third-party", owner });
      } else {
        children.push({
          label: owner,
          children: labels.map((label) => ({ label, action: "third-party", owner }))
        });
      }
    }
    return children.length > 0 ? { label: MORE_MENU_LABEL, children } : null;
  }
  var EVENT_LABELS = {
    balance: "\u4F59\u989D\u6863\u4F4D",
    whisper: "\u788E\u788E\u5FF5",
    workStatus: "\u5DE5\u4F5C\u72B6\u6001"
  };
  var leaf = (anim) => ({ label: anim, anim });
  function buildMenuTree(animations) {
    const groups = [];
    const pools = [
      ["\u5F85\u673A", animations.idle],
      ["\u8F6C\u5411", animations.turn],
      ["\u62D6\u62FD", animations.drag],
      ["\u70B9\u51FB\u56DE\u5E94", animations.clicks],
      ["\u79FB\u52A8", animations.moves.actions.map((m) => m.name)]
    ];
    for (const [label, pool] of pools) {
      if (pool.length) groups.push({ label, children: pool.map(leaf) });
    }
    const cats = (animations.categories ?? []).filter((c) => c.actions.length > 0);
    for (const c of cats) {
      groups.push({ label: c.id, children: c.actions.map(leaf) });
    }
    const events = animations.events ?? {};
    for (const key of Object.keys(events)) {
      const pool = events[key] ?? [];
      const names = [];
      for (const slot of pool) {
        if (typeof slot === "string") names.push(slot);
        else names.push(...slot);
      }
      if (names.length) groups.push({ label: EVENT_LABELS[key] ?? key, children: names.map(leaf) });
    }
    if (!groups.length) return [];
    return [{ label: "\u52A8\u4F5C", children: groups }];
  }
  function isNoMirrorAnimation(categories, anim) {
    return (categories ?? []).some((c) => c.noMirror === true && c.actions.includes(anim));
  }
  var MENU_CSS = [
    ".dsh-pet-menu{position:fixed;left:0;top:0;z-index:2147483000;color:#2b2b2b;font-size:13px;line-height:1.5;",
    "font-family:'Microsoft YaHei UI','Segoe UI','PingFang SC',sans-serif;user-select:none;pointer-events:auto}",
    ".dsh-pet-menu,.dsh-pet-menu *{box-sizing:border-box}",
    ".dsh-pet-menu-column{position:absolute;min-width:150px;max-width:240px;padding:4px;",
    "background:rgba(255,255,255,.98);border:1px solid rgba(0,0,0,.12);border-radius:8px;",
    "box-shadow:0 8px 28px rgba(0,0,0,.2);max-height:min(62vh,460px);overflow-y:auto;",
    // 自定义滚动条：细圆角半透明条（Chromium 系 Chrome/Edge/Electron 走 ::-webkit-scrollbar；
    // Firefox 走 scrollbar-width/scrollbar-color）。thumb 用 border+background-clip 内缩 2px 留白，
    // 与菜单的圆角白底协调；hover 加深并与 item:hover 的蓝呼应。track 透明不抢视觉。
    "scrollbar-width:thin;scrollbar-color:rgba(0,0,0,.22) transparent}",
    ".dsh-pet-menu-column::-webkit-scrollbar{width:8px;height:8px}",
    ".dsh-pet-menu-column::-webkit-scrollbar-track{background:transparent}",
    ".dsh-pet-menu-column::-webkit-scrollbar-thumb{background:rgba(0,0,0,.16);border-radius:4px;",
    "border:2px solid transparent;background-clip:content-box}",
    ".dsh-pet-menu-column::-webkit-scrollbar-thumb:hover{background:rgba(43,99,255,.4);",
    "border:2px solid transparent;background-clip:content-box}",
    ".dsh-pet-menu-column::-webkit-scrollbar-corner{background:transparent}",
    ".dsh-pet-menu-item{position:relative;display:flex;align-items:center;justify-content:space-between;",
    "gap:14px;padding:5px 12px;border-radius:6px;white-space:nowrap;cursor:default}",
    ".dsh-pet-menu-item:hover{background:rgba(43,99,255,.14)}",
    ".dsh-pet-menu-item>span:first-child{min-width:0;overflow:hidden;text-overflow:ellipsis}",
    ".dsh-pet-menu-arrow{color:#9aa0a6;font-size:12px;flex:none}"
  ].join("");
  function isBranchNode(n) {
    return "children" in n && Array.isArray(n.children);
  }
  function mountContextMenu(opts) {
    const { tree, x, y, onAction, onClose, clamp } = opts;
    const c = clamp && Number.isFinite(clamp.x + clamp.y + clamp.w + clamp.h) ? clamp : { x: 0, y: 0, w: window.innerWidth, h: window.innerHeight };
    const root = document.createElement("div");
    root.className = "dsh-pet-menu";
    root.style.left = "0px";
    root.style.top = "0px";
    root.addEventListener("contextmenu", (e) => e.preventDefault());
    let closed = false;
    const openChild = /* @__PURE__ */ new Map();
    let leaveTimer = null;
    const hideChain = (panel) => {
      panel.style.display = "none";
      const child = openChild.get(panel);
      if (child) {
        openChild.delete(panel);
        hideChain(child);
      }
    };
    const showPanel = (panel, item) => {
      const rect = item.getBoundingClientRect();
      panel.style.left = "";
      panel.style.top = "";
      panel.style.display = "block";
      let left = rect.right + 4;
      if (left + panel.offsetWidth > c.x + c.w - 4) left = rect.left - panel.offsetWidth - 4;
      left = Math.max(c.x + 4, left);
      let top = rect.top;
      if (top + panel.offsetHeight > c.y + c.h - 4) top = Math.max(c.y + 4, c.y + c.h - 4 - panel.offsetHeight);
      panel.style.left = left + "px";
      panel.style.top = top + "px";
    };
    const buildPanel = (nodes) => {
      const panel = document.createElement("div");
      panel.className = "dsh-pet-menu-column";
      panel.style.display = "none";
      if (clamp) panel.style.maxHeight = Math.min(460, Math.max(120, c.h - 16)) + "px";
      root.appendChild(panel);
      for (const node of nodes) {
        const item = document.createElement("div");
        item.className = "dsh-pet-menu-item";
        if (isBranchNode(node)) {
          item.classList.add("dsh-pet-menu-branch");
          const label = document.createElement("span");
          label.textContent = node.label;
          const arrow = document.createElement("span");
          arrow.className = "dsh-pet-menu-arrow";
          arrow.textContent = "\u25B8";
          item.appendChild(label);
          item.appendChild(arrow);
          const childPanel = buildPanel(node.children);
          item.addEventListener("mouseenter", () => {
            const prev = openChild.get(panel);
            if (prev && prev !== childPanel) hideChain(prev);
            openChild.set(panel, childPanel);
            showPanel(childPanel, item);
          });
        } else {
          const label = document.createElement("span");
          label.textContent = node.label;
          item.appendChild(label);
          item.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            close();
            onAction(node);
          });
        }
        panel.appendChild(item);
      }
      return panel;
    };
    const rootPanel = buildPanel(tree);
    rootPanel.style.display = "block";
    document.body.appendChild(root);
    rootPanel.style.left = "";
    rootPanel.style.top = "";
    const rw = rootPanel.offsetWidth;
    const rh = rootPanel.offsetHeight;
    rootPanel.style.left = Math.max(c.x + 4, Math.min(x, c.x + c.w - rw - 4)) + "px";
    rootPanel.style.top = Math.max(c.y + 4, Math.min(y, c.y + c.h - rh - 4)) + "px";
    root.addEventListener("mouseleave", () => {
      if (leaveTimer !== null) window.clearTimeout(leaveTimer);
      leaveTimer = window.setTimeout(() => {
        leaveTimer = null;
        close();
      }, 200);
    });
    root.addEventListener("mouseover", () => {
      if (leaveTimer !== null) {
        window.clearTimeout(leaveTimer);
        leaveTimer = null;
      }
    });
    const onDocPointerDown = (e) => {
      if (closed) return;
      if (root.contains(e.target)) return;
      close();
    };
    const onDocKeyDown = (e) => {
      if (closed) return;
      if (e.key === "Escape") close();
    };
    document.addEventListener("mousedown", onDocPointerDown, true);
    document.addEventListener("keydown", onDocKeyDown, true);
    const close = () => {
      if (closed) return;
      closed = true;
      if (leaveTimer !== null) window.clearTimeout(leaveTimer);
      leaveTimer = null;
      document.removeEventListener("mousedown", onDocPointerDown, true);
      document.removeEventListener("keydown", onDocKeyDown, true);
      root.remove();
      if (onClose) onClose();
    };
    return { el: root, close };
  }

  // upstream/src/shared/chat.ts
  var SEND_TIMEOUT_MS = 6e4;
  async function sendChat(baseUrl, text) {
    const res = await fetch(baseUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS)
    });
    const raw = await res.json().catch(() => null);
    if (!raw || typeof raw !== "object") throw new Error("dsh-pet: \u5BF9\u8BDD\u54CD\u5E94\u975E\u6CD5");
    const o = raw;
    if (o.ok !== true) {
      return {
        ok: false,
        reason: o.reason === "provider-missing" || o.reason === "generate-error" || o.reason === "config-error" ? o.reason : "bad-request",
        message: typeof o.message === "string" ? o.message : void 0
      };
    }
    return { ok: true };
  }
  var CHAT_CSS = [
    ".dsh-pet-chat{position:fixed;z-index:2147483001;width:160px;max-width:80vw;",
    "background:rgba(255,255,255,.98);border:1px solid rgba(0,0,0,.12);border-radius:10px;",
    "box-shadow:0 10px 32px rgba(0,0,0,.22);color:#2b2b2b;font-size:14px;line-height:1.5;",
    // 字体与桌宠气泡同款（上首软糖体，两端均已注入 @font-face），风格一致不显正式。
    // 字体族走全局配置变量 --dsh-pet-font-family：弹窗挂在 body 下、继承不到宠物根容器，
    // 所以由两端注入在 documentElement（回退参数 = 改造前的原栈）。
    // 字号保持固定 14px：配置里的 font.size 只作用于气泡与悬浮提示，不改变本弹窗。
    "font-family:var(--dsh-pet-font-family,'ShangshouSoftCandy','Yuanti SC','YouYuan','\u5E7C\u5706','Comic Sans MS','PingFang SC','Microsoft YaHei',sans-serif);",
    "user-select:none}",
    ".dsh-pet-chat *{box-sizing:border-box}",
    ".dsh-pet-chat-input{display:block;width:100%;border:none;outline:none;background:transparent;",
    "padding:8px 11px 9px;font-size:14px;line-height:1.45;color:#2b2b2b;font-family:inherit;",
    "resize:none;overflow:hidden;white-space:pre-wrap;overflow-wrap:anywhere}",
    ".dsh-pet-chat-input::placeholder{color:rgba(43,43,43,.45)}",
    ".dsh-pet-chat-input:disabled{opacity:.55}",
    ".dsh-pet-chat-err{color:#d94f3d;font-size:12px;padding:0 12px 8px;white-space:pre-wrap;overflow-wrap:anywhere}"
  ].join("");
  var CHAT_MIN_W = 160;
  var CHAT_MAX_W = 340;
  var CHAT_H_PAD = 22;
  var chatCssInjected = false;
  function injectChatCss() {
    if (chatCssInjected || typeof document === "undefined") return;
    chatCssInjected = true;
    const tag = document.createElement("style");
    tag.dataset.plugin = "dsh-pet";
    tag.dataset.pluginCss = "dsh-pet/chat";
    tag.textContent = CHAT_CSS;
    document.head.appendChild(tag);
  }
  function mountChatDialog(opts) {
    injectChatCss();
    const { petId, surface, x, y, onSent, onClose, clamp } = opts;
    const baseUrl = opts.baseUrl ?? "/dsh-pet-7340/chat";
    const withPet = baseUrl + "?pet=" + encodeURIComponent(petId) + "&surface=" + surface;
    const c = clamp && Number.isFinite(clamp.x + clamp.y + clamp.w + clamp.h) ? clamp : { x: 0, y: 0, w: window.innerWidth, h: window.innerHeight };
    const root = document.createElement("div");
    root.className = "dsh-pet-chat";
    const input = document.createElement("textarea");
    input.className = "dsh-pet-chat-input";
    input.placeholder = "\u8BF4\u70B9\u4EC0\u4E48\u2026";
    input.maxLength = 2e3;
    input.rows = 1;
    let measureCtx = null;
    const measureText = (text) => {
      const ctx = measureCtx ?? (measureCtx = document.createElement("canvas").getContext("2d"));
      ctx.font = getComputedStyle(input).font;
      return ctx.measureText(text).width;
    };
    const resizeInput = () => {
      const textW = measureText(input.value || " ");
      const w = Math.max(CHAT_MIN_W, Math.min(Math.ceil(textW + CHAT_H_PAD), CHAT_MAX_W));
      root.style.width = w + "px";
      input.style.height = "auto";
      input.style.height = Math.max(input.scrollHeight, 22) + "px";
    };
    input.addEventListener("input", resizeInput);
    resizeInput();
    const err = document.createElement("div");
    err.className = "dsh-pet-chat-err";
    err.style.display = "none";
    root.appendChild(input);
    root.appendChild(err);
    document.body.appendChild(root);
    resizeInput();
    const rr = root.getBoundingClientRect();
    root.style.left = Math.max(c.x + 4, Math.min(x, c.x + c.w - rr.width - 4)) + "px";
    root.style.top = Math.max(c.y + 4, Math.min(y, c.y + c.h - rr.height - 4)) + "px";
    let closed = false;
    let sending = false;
    const close = () => {
      if (closed) return;
      closed = true;
      document.removeEventListener("mousedown", onDocPointerDown, true);
      document.removeEventListener("keydown", onDocKeyDown, true);
      root.remove();
      if (onClose) onClose();
    };
    const onDocPointerDown = (e) => {
      if (closed) return;
      if (root.contains(e.target)) return;
      close();
    };
    const onDocKeyDown = (e) => {
      if (closed) return;
      if (e.key === "Escape") close();
    };
    document.addEventListener("mousedown", onDocPointerDown, true);
    document.addEventListener("keydown", onDocKeyDown, true);
    const doSend = () => {
      if (closed || sending) return;
      const text = input.value.trim();
      if (!text) return;
      sending = true;
      input.disabled = true;
      sendChat(withPet, text).then((state) => {
        if (state.ok) {
          close();
          if (onSent) onSent();
        } else {
          err.textContent = "\u5BF9\u8BDD\u5931\u8D25\uFF1A" + (state.message ?? state.reason);
          err.style.display = "block";
        }
      }).catch((e) => {
        err.textContent = "\u5BF9\u8BDD\u5F02\u5E38\uFF1A" + String(e && e.message ? e.message : e);
        err.style.display = "block";
      }).finally(() => {
        sending = false;
        input.disabled = false;
        if (!closed) input.focus();
      });
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        doSend();
      }
    });
    input.focus();
    return { el: root, close };
  }

  // upstream/src/shared/physics.ts
  var SPRING_K = 200;
  var SPRING_C = 30;
  var TRAIL_KEEP_MS = 200;
  var RELEASE_WINDOW_MS = 150;
  var RELEASE_STALE_MS = 150;
  var MIN_SPAN_MS = 20;
  var SEG_MIN_DT_MS = 8;
  var DEAD_ZONE_SPEED = 500;
  var MAX_THROW_SPEED = 3600;
  var PEAK_WEIGHT = 0.5;
  var ACCEL_REF = 8e3;
  var ACCEL_GAIN_MAX = 0.6;
  var GRAVITY = 1400;
  var RESTITUTION = 0.78;
  var GROUND_FRICTION = 2.5;
  var DEFAULT_PHYSICS = {
    gravity: GRAVITY,
    restitution: RESTITUTION,
    groundFriction: GROUND_FRICTION,
    ceilingBounce: true,
    throwPower: 1,
    petCollision: false
  };
  var DEFAULT_THROW_POWER = 1;
  var REST_VY = 40;
  var REST_VX = 15;
  var MAX_STEP_DT = 0.05;
  var SQ_SQUASH = 0.55;
  var SQ_DURATION_MS = 220;
  var SQ_SOFT_SPEED = 300;
  var SQ_HARD_SPEED = 1500;
  var SQ_MAX_SQUASH = 0.55;
  var landingSquash = (impactSpeed) => {
    const t = Math.min(Math.max((Math.abs(impactSpeed) - SQ_SOFT_SPEED) / (SQ_HARD_SPEED - SQ_SOFT_SPEED), 0), 1);
    return Math.min(0.8, 1 - t * (1 - SQ_MAX_SQUASH));
  };
  var squashScale = (u, squash = SQ_SQUASH) => {
    if (u < 0.45) {
      const p2 = u / 0.45;
      return 1 - (1 - squash) * p2 * p2;
    }
    const p = (u - 0.45) / 0.55;
    const c1 = 1.70158;
    const c3 = c1 + 1;
    const f = 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2);
    return Math.min(1.12, squash + (1 - squash) * Math.max(f, 0));
  };
  var throwBounds = (o) => {
    const h = o.size * 9 / 16;
    return { minX: -o.sideAllow, minY: 0, maxX: o.W - o.size + o.sideAllow, maxY: o.H - h };
  };
  var throwBoundsIn = (area, size, sideAllow) => {
    const h = size * 9 / 16;
    return {
      minX: area.x - sideAllow,
      minY: area.y,
      maxX: rectRight(area) - size + sideAllow,
      maxY: rectBottom(area) - h
    };
  };
  var throwSpace = (o) => ({
    bounds: o.areas.map((a) => throwBoundsIn(a, o.size, o.sideAllow)),
    areas: o.areas,
    panels: o.panels && o.panels.length === o.areas.length ? o.panels : o.areas,
    // 面板缺失/不同序：退化用工作区（保持旧行为）
    size: o.size,
    sideAllow: o.sideAllow
  });
  var screenOfBox = (space, x, y) => {
    const cx = x + space.size / 2;
    const cy = y + space.size * 9 / 16 / 2;
    const hit = indexAtPoint(space.areas, cx, cy);
    return hit >= 0 ? hit : nearestIndex(space.areas, cx, cy);
  };
  var trimTrail = (trail, now) => {
    const cutoff = now - TRAIL_KEEP_MS;
    let i = 0;
    while (i < trail.length && trail[i].t < cutoff) i++;
    return i === 0 ? trail : trail.slice(i);
  };
  var springStep = (v, x, target, dt, power = DEFAULT_THROW_POWER) => v + ((target - x) * SPRING_K - v * SPRING_C) * power * dt;
  var softClampSpeed = (speed) => {
    if (speed <= 0) return 0;
    return MAX_THROW_SPEED * (1 - Math.exp(-speed / MAX_THROW_SPEED));
  };
  var THROW_SPEED_ANCHOR = 1200;
  var throwVelocity = (angleDeg, power) => {
    const speed = softClampSpeed(power * THROW_SPEED_ANCHOR);
    const rad = angleDeg * Math.PI / 180;
    return { vx: Math.cos(rad) * speed, vy: -Math.sin(rad) * speed };
  };
  var estimateReleaseVelocity = (trail, now, physics = DEFAULT_PHYSICS) => {
    if (trail.length === 0) return null;
    const last = trail[trail.length - 1];
    if (now - last.t > RELEASE_STALE_MS) return null;
    const win = trail.filter((s) => now - s.t <= RELEASE_WINDOW_MS);
    if (win.length < 2) return null;
    const t0 = win[0].t;
    const x0 = win[0].x;
    const y0 = win[0].y;
    const t1 = win[win.length - 1].t;
    const x1 = win[win.length - 1].x;
    const y1 = win[win.length - 1].y;
    const spanMs = t1 - t0;
    if (spanMs < MIN_SPAN_MS) return null;
    const baseVx = (x1 - x0) / spanMs * 1e3;
    const baseVy = (y1 - y0) / spanMs * 1e3;
    const baseSpeed = Math.hypot(baseVx, baseVy);
    if (baseSpeed < 1e-6) return null;
    const segSpeeds = [];
    let px = x0;
    let py = y0;
    let pt = t0;
    for (const s of win.slice(1)) {
      const dt = s.t - pt;
      if (dt >= SEG_MIN_DT_MS) {
        segSpeeds.push({ speed: Math.hypot(s.x - px, s.y - py) / dt * 1e3, tEnd: s.t });
        px = s.x;
        py = s.y;
        pt = s.t;
      }
    }
    const peakSpeed = segSpeeds.length ? Math.max(...segSpeeds.map((v) => v.speed)) : baseSpeed;
    let accel = 0;
    if (segSpeeds.length >= 2) {
      const lastSeg = segSpeeds[segSpeeds.length - 1];
      const firstSeg = segSpeeds[0];
      accel = (lastSeg.speed - firstSeg.speed) / Math.max((lastSeg.tEnd - firstSeg.tEnd) / 1e3, MIN_SPAN_MS / 1e3);
    }
    const speedBeforeClamp = ((1 - PEAK_WEIGHT) * baseSpeed + PEAK_WEIGHT * peakSpeed) * (1 + Math.min(Math.max(accel, 0) / ACCEL_REF, 1) * ACCEL_GAIN_MAX);
    const speed = softClampSpeed(speedBeforeClamp) * physics.throwPower;
    if (speed < DEAD_ZONE_SPEED) return null;
    return { vx: baseVx / baseSpeed * speed, vy: baseVy / baseSpeed * speed };
  };
  var throwStep = (s, dtRaw, b, physics = DEFAULT_PHYSICS) => {
    const dt = Math.min(Math.max(dtRaw, 0), MAX_STEP_DT);
    let { x, y, vx, vy } = s;
    vy += physics.gravity * dt;
    x += vx * dt;
    y += vy * dt;
    let bounced = false;
    if (x < b.minX) {
      x = b.minX;
      vx = Math.abs(vx) * physics.restitution;
      bounced = true;
    } else if (x > b.maxX) {
      x = b.maxX;
      vx = -Math.abs(vx) * physics.restitution;
      bounced = true;
    }
    if (y < b.minY) {
      if (physics.ceilingBounce) {
        y = b.minY;
        vy = Math.abs(vy) * physics.restitution;
        bounced = true;
      }
    } else if (y >= b.maxY) {
      y = b.maxY;
      vx *= Math.max(0, 1 - physics.groundFriction * dt);
      if (Math.abs(vy) < REST_VY) vy = 0;
      else vy = -Math.abs(vy) * physics.restitution;
      bounced = true;
    }
    const speed = Math.hypot(vx, vy);
    const atRest = y >= b.maxY - 1 && Math.abs(vy) < 1 && Math.abs(vx) < REST_VX || bounced && speed < REST_VY && Math.abs(vy) < 1;
    return { x, y, vx, vy, bounced, atRest };
  };
  var throwStepRegion = (s, dtRaw, space, physics = DEFAULT_PHYSICS, lockScreen = -1) => {
    const dt = Math.min(Math.max(dtRaw, 0), MAX_STEP_DT);
    let { x, y, vx, vy } = s;
    vy += physics.gravity * dt;
    x += vx * dt;
    y += vy * dt;
    if (space.areas.length === 0) return { x, y, vx, vy, screen: -1, bounced: false, atRest: false };
    const h = space.size * 9 / 16;
    let bounced = false;
    const locked = Number.isInteger(lockScreen) && lockScreen >= 0 && lockScreen < space.areas.length;
    const pick2 = (i) => locked ? lockScreen : i;
    let cur = screenOfBox(space, x, y);
    let b = space.bounds[pick2(cur)];
    let a = space.areas[pick2(cur)];
    const pa = space.panels[pick2(cur)] || a;
    const cy = y + h / 2;
    if (x < b.minX) {
      if (locked || indexAtPoint(space.panels, pa.x - 1, cy) < 0) {
        x = b.minX;
        vx = Math.abs(vx) * physics.restitution;
        bounced = true;
      }
    } else if (x > b.maxX) {
      if (locked || indexAtPoint(space.panels, rectRight(pa), cy) < 0) {
        x = b.maxX;
        vx = -Math.abs(vx) * physics.restitution;
        bounced = true;
      }
    }
    cur = screenOfBox(space, x, y);
    b = space.bounds[pick2(cur)];
    a = space.areas[pick2(cur)];
    const pa2 = space.panels[pick2(cur)] || a;
    const cx = x + space.size / 2;
    if (y < b.minY) {
      if (physics.ceilingBounce && (locked || indexAtPoint(space.panels, cx, pa2.y - 1) < 0)) {
        y = b.minY;
        vy = Math.abs(vy) * physics.restitution;
        bounced = true;
      }
    } else if (y >= b.maxY) {
      if (locked || indexAtPoint(space.panels, cx, rectBottom(pa2)) < 0) {
        y = b.maxY;
        vx *= Math.max(0, 1 - physics.groundFriction * dt);
        if (Math.abs(vy) < REST_VY) vy = 0;
        else vy = -Math.abs(vy) * physics.restitution;
        bounced = true;
      }
    }
    cur = pick2(screenOfBox(space, x, y));
    b = space.bounds[cur];
    const speed = Math.hypot(vx, vy);
    const atRest = y >= b.maxY - 1 && Math.abs(vy) < 1 && Math.abs(vx) < REST_VX || bounced && speed < REST_VY && Math.abs(vy) < 1;
    return { x, y, vx, vy, screen: cur, bounced, atRest };
  };
  var PET_BOUNCE_E = 0.995;
  var bodyPixelBox = (o) => {
    const h = o.size * 9 / 16;
    return {
      left: o.x + HIT_BOX.x0 / 640 * o.size,
      top: o.y + o.bottomPad + HIT_BOX.y0 / 360 * h,
      right: o.x + HIT_BOX.x1 / 640 * o.size,
      bottom: o.y + o.bottomPad + HIT_BOX.y1 / 360 * h
    };
  };
  var rectsOverlap = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
  var collidePet = (fly, hit) => {
    const hf = fly.size * 9 / 16 / 2;
    const hh = hit.size * 9 / 16 / 2;
    const cx = hit.x + hit.size / 2 - (fly.x + fly.size / 2);
    const cy = hit.y + hh - (fly.y + hf);
    const dist = Math.hypot(cx, cy);
    if (dist < 1e-6) return null;
    const nx = cx / dist;
    const ny = cy / dist;
    const vrel = (fly.vx - hit.vx) * nx + (fly.vy - hit.vy) * ny;
    if (vrel <= 0) return null;
    const e = PET_BOUNCE_E;
    const m1 = fly.size * fly.size;
    const m2 = hit.size * hit.size;
    const v1n = fly.vx * nx + fly.vy * ny;
    const v2n = hit.vx * nx + hit.vy * ny;
    const v1n2 = ((m1 - e * m2) * v1n + (1 + e) * m2 * v2n) / (m1 + m2);
    const v2n2 = ((m2 - e * m1) * v2n + (1 + e) * m1 * v1n) / (m1 + m2);
    return {
      fvx: fly.vx - v1n * nx + v1n2 * nx,
      fvy: fly.vy - v1n * ny + v1n2 * ny,
      hvx: hit.vx - v2n * nx + v2n2 * nx,
      hvy: hit.vy - v2n * ny + v2n2 * ny
    };
  };

  // upstream/src/shared/score.ts
  var SCORE_MIN_SPEED = 400;
  var SCORE_SPEED_PER_POINT = 100;
  var clickScore = (speed, size) => {
    if (speed <= 0 || size <= 0) return 0;
    return Math.max(1, Math.round(speed / SCORE_SPEED_PER_POINT * (PET_REF_WIDTH / size)));
  };

  // upstream/src/shared/score-popup.ts
  var SCORE_POPUP_DURATION_MS = 2200;
  var SCORE_POPUP_CSS = [
    // 积分卡片：金色主值 + 灰色明细，居中，弹出动画
    ".dsh-pet-score{position:fixed;z-index:2147483002;min-width:120px;text-align:center;",
    "background:rgba(255,255,255,.97);border:1px solid rgba(255,179,0,.35);border-radius:12px;",
    "box-shadow:0 10px 32px rgba(0,0,0,.22);padding:8px 16px 9px;user-select:none;pointer-events:auto;",
    // 字体族走全局配置变量（由两端注入在 documentElement）：弹窗挂在 body 下，继承不到宠物根容器；
    // 回退参数 = 改造前的原栈。字号保持固定 px（配置的 font.size 只作用于气泡与悬浮提示）。
    "font-family:var(--dsh-pet-font-family,'ShangshouSoftCandy','Yuanti SC','YouYuan','\u5E7C\u5706','Comic Sans MS','PingFang SC','Microsoft YaHei',sans-serif);}",
    ".dsh-pet-score.is-in{animation:dshPetScorePop .28s ease}",
    ".dsh-pet-score-val{font-size:22px;line-height:1.25;font-weight:700;color:#ff8f00;font-variant-numeric:tabular-nums}",
    ".dsh-pet-score-sub{font-size:11px;line-height:1.4;color:rgba(43,43,43,.6);margin-top:2px;white-space:nowrap}",
    // 粒子层：整屏固定、不挡交互；粒子为绝对定位小圆点，位移/透明度由 rAF 直接写
    ".dsh-pet-score-burst{position:fixed;inset:0;pointer-events:none;z-index:2147483002}",
    ".dsh-pet-score-particle{position:absolute;border-radius:50%;pointer-events:none}",
    "@keyframes dshPetScorePop{from{transform:scale(.6);opacity:0}to{transform:scale(1);opacity:1}}"
  ].join("");
  var scoreCssInjected = false;
  function injectScoreCss() {
    if (scoreCssInjected || typeof document === "undefined") return;
    scoreCssInjected = true;
    const tag = document.createElement("style");
    tag.dataset.plugin = "dsh-pet";
    tag.dataset.pluginCss = "dsh-pet/score";
    tag.textContent = SCORE_POPUP_CSS;
    document.head.appendChild(tag);
  }
  var BURST_COUNT = 20;
  var BURST_SPEED_MIN = 120;
  var BURST_SPEED_MAX = 460;
  var BURST_GRAVITY = 700;
  var BURST_LIFE_MIN = 500;
  var BURST_LIFE_MAX = 900;
  var BURST_RADIUS_MIN = 3;
  var BURST_RADIUS_MAX = 7;
  var BURST_COLORS = ["#ffb300", "#ff8f00", "#ff7043", "#f4511e", "#ffc400", "#ffd54f", "#ef5350"];
  function spawnScoreBurst(x, y) {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    injectScoreCss();
    const root = document.createElement("div");
    root.className = "dsh-pet-score-burst";
    document.body.appendChild(root);
    const parts = [];
    for (let i = 0; i < BURST_COUNT; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = BURST_SPEED_MIN + Math.random() * (BURST_SPEED_MAX - BURST_SPEED_MIN);
      const r = BURST_RADIUS_MIN + Math.random() * (BURST_RADIUS_MAX - BURST_RADIUS_MIN);
      const el = document.createElement("div");
      el.className = "dsh-pet-score-particle";
      el.style.left = x + "px";
      el.style.top = y + "px";
      el.style.width = r * 2 + "px";
      el.style.height = r * 2 + "px";
      el.style.background = BURST_COLORS[Math.floor(Math.random() * BURST_COLORS.length)];
      root.appendChild(el);
      parts.push({
        el,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 80,
        t0: performance.now(),
        life: BURST_LIFE_MIN + Math.random() * (BURST_LIFE_MAX - BURST_LIFE_MIN)
      });
    }
    const step = () => {
      const now = performance.now();
      let alive = false;
      for (const p of parts) {
        const tSec = (now - p.t0) / 1e3;
        const lifeRatio = (now - p.t0) / p.life;
        if (lifeRatio >= 1) continue;
        alive = true;
        p.el.style.transform = "translate(" + p.vx * tSec + "px," + (p.vy * tSec + 0.5 * BURST_GRAVITY * tSec * tSec) + "px)";
        p.el.style.opacity = String(Math.max(0, 1 - lifeRatio));
      }
      if (alive) requestAnimationFrame(step);
      else root.remove();
    };
    requestAnimationFrame(step);
  }
  function mountScorePopup(opts) {
    injectScoreCss();
    const x = opts.x;
    const y = opts.y;
    const root = document.createElement("div");
    root.className = "dsh-pet-score";
    const val = document.createElement("div");
    val.className = "dsh-pet-score-val";
    val.textContent = "+" + opts.score;
    const sub = document.createElement("div");
    sub.className = "dsh-pet-score-sub";
    sub.textContent = "\u901F\u5EA6 " + Math.round(opts.speed) + " \xB7 \u5927\u5C0F " + Math.round(opts.size);
    root.appendChild(val);
    root.appendChild(sub);
    document.body.appendChild(root);
    const rr = root.getBoundingClientRect();
    root.style.left = Math.max(4, Math.min(x - rr.width / 2, window.innerWidth - rr.width - 4)) + "px";
    root.style.top = Math.max(4, y - rr.height - 14) + "px";
    void root.offsetWidth;
    root.classList.add("is-in");
    let closed = false;
    let timer = null;
    const close = () => {
      if (closed) return;
      closed = true;
      if (timer !== null) window.clearTimeout(timer);
      timer = null;
      document.removeEventListener("mousedown", onDocPointerDown, true);
      document.removeEventListener("keydown", onDocKeyDown, true);
      root.remove();
      if (opts.onClose) opts.onClose();
    };
    const mountedAt = performance.now();
    let graceConsumed = false;
    const onDocPointerDown = (e) => {
      if (closed) return;
      if (!graceConsumed) {
        graceConsumed = true;
        if (e.timeStamp - mountedAt < 300) return;
      }
      if (root.contains(e.target)) return;
      close();
    };
    const onDocKeyDown = (e) => {
      if (closed) return;
      if (e.key === "Escape") close();
    };
    document.addEventListener("mousedown", onDocPointerDown, true);
    document.addEventListener("keydown", onDocKeyDown, true);
    timer = window.setTimeout(close, SCORE_POPUP_DURATION_MS);
    return { el: root, close };
  }

  // upstream/src/shared/work-status.ts
  var WORK_STATUS_STATES = ["thinking", "working", "result", "waiting", "success", "error"];
  var WORK_STATUS_INDEX = {
    thinking: 0,
    // turn/start → 思考
    working: 1,
    // tool/call → 工作
    result: 2,
    // tool/result → 整理
    waiting: 3,
    // approval/asked → 等待
    success: 4,
    // turn/end completed → 完成
    error: 5
    // turn/end error/max-tokens → 出错
  };
  function toWorkStatus(raw) {
    if (!raw || typeof raw !== "object") return null;
    const r = raw;
    const state = r.state === null || typeof r.state === "string" && WORK_STATUS_STATES.includes(r.state) ? r.state : null;
    return { state, task: typeof r.task === "string" ? r.task : null };
  }

  // upstream/src/shared/state.ts
  function normLeaf(value) {
    if (!value || typeof value !== "object") return null;
    const leaf2 = value;
    if (typeof leaf2.counter !== "number" || !Number.isFinite(leaf2.counter)) return null;
    return { counter: leaf2.counter, data: leaf2.data ?? null };
  }
  async function fetchState(baseUrl = "/dsh-pet-7340/state", wait) {
    try {
      const url = wait ? `${baseUrl}?since=${wait.since}&timeout=${wait.timeoutMs}` : baseUrl;
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) return null;
      const raw = await res.json().catch(() => null);
      if (!raw || typeof raw !== "object") return null;
      const sections = {};
      const rawSections = raw.sections && typeof raw.sections === "object" ? raw.sections : {};
      for (const [name, value] of Object.entries(rawSections)) {
        const leaf2 = normLeaf(value);
        if (leaf2) sections[name] = leaf2;
      }
      const pets = {};
      const rawPets = raw.pets && typeof raw.pets === "object" ? raw.pets : {};
      for (const [petId, entry] of Object.entries(rawPets)) {
        if (!entry || typeof entry !== "object") continue;
        const leaves = {};
        for (const [name, value] of Object.entries(entry)) {
          const leaf2 = normLeaf(value);
          if (leaf2) leaves[name] = leaf2;
        }
        pets[petId] = leaves;
      }
      return {
        counter: typeof raw.counter === "number" && Number.isFinite(raw.counter) ? raw.counter : void 0,
        sections,
        pets
      };
    } catch {
      return null;
    }
  }
  function* walkLeaves(s) {
    for (const [name, leaf2] of Object.entries(s.sections ?? {})) yield ["sections." + name, leaf2];
    for (const [petId, leaves] of Object.entries(s.pets ?? {})) {
      for (const [name, leaf2] of Object.entries(leaves ?? {})) yield ["pets." + petId + "." + name, leaf2];
    }
  }
  function flattenCounters(s) {
    const out = {};
    for (const [path, leaf2] of walkLeaves(s)) out[path] = leaf2.counter;
    return out;
  }
  function takeChanged(s, baseline) {
    const out = [];
    for (const [path, leaf2] of walkLeaves(s)) {
      if (baseline[path] === leaf2.counter) continue;
      baseline[path] = leaf2.counter;
      out.push({ path, leaf: leaf2 });
    }
    return out;
  }
  function readBalance(leaf2) {
    const state = toBalanceState(leaf2.data);
    if (!state) return null;
    const manual = leaf2.data.manual === true;
    return { state, manual };
  }
  function readSay(leaf2) {
    if (!leaf2.data || typeof leaf2.data !== "object") return null;
    const d = leaf2.data;
    if (d.clear === true) return { kind: "clear" };
    if (typeof d.text !== "string" || !d.text) return null;
    return {
      kind: "say",
      text: d.text,
      image: typeof d.image === "string" ? d.image : void 0,
      // 第三方给的配图地址（完整 URL，scheme 已由宿主卡在 http/https）。与 image 并列、互斥，
      // 消费端"有 url 就用 url，否则拼表情包路径"——判别位在字段名上，见 SayCue 的说明。
      url: typeof d.url === "string" ? d.url : void 0,
      // 只认 ≥0 的有限数：非法值当"没给"（写端已校验，这里只是防御，不让脏数据毁掉整拍）
      duration: typeof d.duration === "number" && Number.isFinite(d.duration) && d.duration >= 0 ? d.duration : void 0,
      anim: typeof d.anim === "boolean" ? d.anim : void 0
    };
  }
  function readWorkStatus(leaf2) {
    return toWorkStatus(leaf2.data);
  }
  function readAnim(leaf2) {
    if (!leaf2.data || typeof leaf2.data !== "object") return null;
    const d = leaf2.data;
    const name = typeof d.name === "string" && d.name ? d.name : void 0;
    const url = typeof d.url === "string" && d.url ? d.url : void 0;
    if (name === void 0 && url === void 0) return null;
    return {
      name,
      url,
      playbackId: typeof d.playbackId === "string" && d.playbackId ? d.playbackId : void 0,
      // 朝向：只认两个字面量，其余（含缺省、老 host、脏值）一律 undefined = 不动朝向
      facing: d.facing === "left" || d.facing === "right" ? d.facing : void 0
    };
  }
  function readLock(leaf2) {
    if (!leaf2.data || typeof leaf2.data !== "object") return null;
    const d = leaf2.data;
    if (d.locked === false) return { locked: false };
    if (d.locked !== true) return null;
    if (typeof d.expiresAt !== "number" || !Number.isFinite(d.expiresAt)) return null;
    return { locked: true, expiresAt: d.expiresAt };
  }
  function readPosition(leaf2) {
    if (!leaf2.data || typeof leaf2.data !== "object") return null;
    const d = leaf2.data;
    if (typeof d.x !== "number" || !Number.isFinite(d.x)) return null;
    if (typeof d.y !== "number" || !Number.isFinite(d.y)) return null;
    if (d.mode !== "instant" && d.mode !== "spring" && d.mode !== "line") return null;
    if (d.mode === "line") {
      if (typeof d.duration !== "number" || !Number.isFinite(d.duration) || d.duration < 0) return null;
      return { x: d.x, y: d.y, mode: "line", duration: d.duration };
    }
    return { x: d.x, y: d.y, mode: d.mode, duration: 0 };
  }
  function readThrow(leaf2) {
    if (!leaf2.data || typeof leaf2.data !== "object") return null;
    const d = leaf2.data;
    if (typeof d.angle !== "number" || !Number.isFinite(d.angle)) return null;
    if (typeof d.power !== "number" || !Number.isFinite(d.power) || d.power <= 0) return null;
    return { angle: d.angle, power: d.power };
  }
  async function postAction(baseUrl, body) {
    try {
      const res = await fetch(baseUrl, {
        method: "POST",
        ...body === void 0 ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
      });
      if (!res.ok) return false;
      const data = await res.json().catch(() => null);
      return data?.ok === true;
    } catch {
      return false;
    }
  }

  // upstream/src/shared/tooltip.ts
  var TOOLTIP_CLASS = "pet-tooltip";
  var TOOLTIP_GAP_RATIO = 0.022;
  function tooltipPlacement(cursor, tip, bounds, gap) {
    const clamp = (v, lo, hi) => hi < lo ? lo : Math.min(Math.max(v, lo), hi);
    const rightMax = bounds.x + bounds.w;
    const bottomMax = bounds.y + bounds.h;
    let x = cursor.x + gap;
    if (x + tip.w > rightMax) x = cursor.x - gap - tip.w;
    x = clamp(x, bounds.x, rightMax - tip.w);
    let y = cursor.y + gap;
    if (y + tip.h > bottomMax) y = cursor.y - gap - tip.h;
    y = clamp(y, bounds.y, bottomMax - tip.h);
    return { x, y };
  }
  var TOOLTIP_CSS = [
    ".pet-tooltip{",
    // fixed + 坐标由 JS 按光标写（见 tooltipPlacement）：left/top 只是未定位前的兜底，不会显示出来
    "position:fixed;left:0;top:0;",
    "max-width:calc(var(--dsh-pet-size,var(--pet-size,462px))*0.8);",
    "padding:calc(var(--dsh-pet-size,var(--pet-size,462px))*0.010) calc(var(--dsh-pet-size,var(--pet-size,462px))*0.021);",
    "border-radius:calc(var(--dsh-pet-size,var(--pet-size,462px))*0.016);",
    // 白底黑字（对齐原生提示的观感；文字色与气泡一致）——深色胶囊落在浅色宠物身上太抢眼
    "background:rgba(255,255,255,.96);color:#1f1f1f;",
    // 细边框：白底压到浅色宠物或浅色页面上会糊成一片，靠它划出轮廓（原生提示也有一道边）
    "border:1px solid rgba(0,0,0,.12);",
    // 字体与气泡同一套（上首软糖体由两端各自注入 @font-face：客户端 bubble.ts、桌面 renderer.js）。
    // 字体族走全局配置变量 --dsh-pet-font-family（注入在 documentElement，回退参数 = 改造前的原栈）
    'font-family:var(--dsh-pet-font-family,"ShangshouSoftCandy","Yuanti SC","YouYuan","\u5E7C\u5706","Comic Sans MS","PingFang SC","Microsoft YaHei",sans-serif);',
    // 字号对齐 Windows 原生提示（9pt ≈ 12px）：462px 的宠物下 0.026 → 约 12px。
    // --dsh-pet-font-tip 由两端按该宠物尺寸算好注入（shared/fonts.ts 的 resolveFontPx，
    // 而非常量：followPet 关闭或字号被改时取值随之变化）；未注入时回退原表达式，行为与改造前一致。
    "font-size:var(--dsh-pet-font-tip,calc(var(--dsh-pet-size,var(--pet-size,462px))*0.026));line-height:1.4;",
    // nowrap + 截断：宽度锁成一行才好和光标一起摆（换行会让宽度随位置跳变）
    "white-space:nowrap;overflow:hidden;text-overflow:ellipsis;",
    // 不设 backdrop-filter：白底没必要，原生提示也没有毛玻璃
    "box-shadow:0 calc(var(--dsh-pet-size,var(--pet-size,462px))*0.004) calc(var(--dsh-pet-size,var(--pet-size,462px))*0.013) rgba(0,0,0,.18);",
    // 层级低于气泡（气泡 z-index:3）：两者不再抢同一块地方（提示跟光标、气泡在头顶），保留层序只是兜底
    "opacity:0;transition:opacity .12s ease;pointer-events:none;z-index:2}",
    ".pet-tooltip.is-on{opacity:1}"
  ].join("");
  return __toCommonJS(index_exports);
})();
