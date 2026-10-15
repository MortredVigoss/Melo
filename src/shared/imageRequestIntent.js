// Direct natural-language image requests. Callers mask quotations and reject
// prohibitions / tutorials before using these execution (not capability) gates.
export function requestsPhotoAdjustment(text) {
  return /(?:增加|提高|降低|减少|增强|减弱|调整|调高|调低|加|减)[^，。；!?;\n]{0,10}(?:对比度|饱和度|曝光|亮度|锐度|清晰度)|(?:对比度|饱和度|曝光|亮度)[^，。；!?;\n]{0,10}(?:高|低|强|弱|加|减|多|少|一点)|(?:粉|蓝|红|绿|黄|白|黑|紫)(?:色)?更(?:粉|蓝|红|绿|黄|白|黑|紫)|(?:颜色|色彩).{0,8}(?:鲜艳|饱和|淡|浓)|\b(?:increase|decrease|boost|reduce|adjust)\b.{0,25}\b(?:contrast|saturation|exposure|brightness|sharpness)\b|\b(?:more|less)\s+(?:contrast|saturation)|\b(?:pinker|bluer|redder|brighter|darker)\b/iu.test(text);
}
export function requestsNaturalImage(text) {
  return /^(?:请|帮我|给我|麻烦|你|再|直接|请帮我)*\s*(?:(?:画|绘制)(?:一(?:个|只|张|幅|条|匹)?|个|只|张|幅|图)|(?:生成|制作|做|设计|出|来)\s*(?:一|几|两|三|\d+)?\s*(?:张|个|幅)?\s*(?:图(?:片|像|标)?|海报|封面|插图|插画|壁纸|头像|logo|banner))|^(?:please\s+)?(?:(?:draw|sketch|paint|illustrate)\s+(?:me\s+)?(?:a|an|the)\s+\w+|(?:generate|create|make|design|render)\s+(?:me\s+)?(?:a|an|the|some)?\s*(?:\w+\s+){0,2}(?:images?|pictures?|photos?|posters?|logos?|icons?|illustrations?|wallpapers?|banners?)\b)/iu.test(text);
}
