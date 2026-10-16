// Direct natural-language image requests. Callers mask quotations and reject
// prohibitions / tutorials before using these execution (not capability) gates.
export function requestsPhotoAdjustment(text) {
  return /(?:增加|提高|降低|减少|增强|减弱|调整|调高|调低|加|减)[^，。；!?;\n]{0,10}(?:对比度|饱和度|曝光|亮度|锐度|清晰度)|(?:对比度|饱和度|曝光|亮度)[^，。；!?;\n]{0,10}(?:高|低|强|弱|加|减|多|少|一点)|(?:粉|蓝|红|绿|黄|白|黑|紫)(?:色)?更(?:粉|蓝|红|绿|黄|白|黑|紫)|(?:颜色|色彩).{0,8}(?:鲜艳|饱和|淡|浓)|\b(?:increase|decrease|boost|reduce|adjust)\b.{0,25}\b(?:contrast|saturation|exposure|brightness|sharpness)\b|\b(?:more|less)\s+(?:contrast|saturation)|\b(?:pinker|bluer|redder|brighter|darker)\b/iu.test(text);
}
export function requestsNaturalImage(text) {
  return /^(?:请|帮我|给我|麻烦|你|再|直接|请帮我)*\s*(?:(?:画|绘制)(?:一(?:个|只|张|幅|条|匹)?|个|只|张|幅|图)|(?:生成|制作|做|设计|出|来)\s*(?:一|几|两|三|\d+)?\s*(?:张|个|幅)?\s*(?:图(?:片|像|标)?|海报|封面|插图|插画|壁纸|头像|logo|banner))|^(?:please\s+)?(?:(?:draw|sketch|paint|illustrate)\s+(?:me\s+)?(?:a|an|the)\s+\w+|(?:generate|create|make|design|render)\s+(?:me\s+)?(?:a|an|the|some)?\s*(?:\w+\s+){0,2}(?:images?|pictures?|photos?|posters?|logos?|icons?|illustrations?|wallpapers?|banners?)\b)/iu.test(text);
}
// A photo attached to the current message plus an instruction (not a question
// or a request to look at it) is an edit, however it is phrased. The phone
// mirrors this in ImageTaskPlan.asksAboutImage / instructsChange.
export function asksAboutImage(text) {
  return /[?？]\s*$|吗|什么|怎么样|如何|为什么|哪|是不是|是否|多少|(?<![这那])几(?:个|张|只|种)|谁|看看|看一下|看下|分析|识别|认一下|描述|解释|说明|介绍|翻译|总结|提取|读一下|评价|点评|检查|有没有|告诉我|这是|那是|\b(?:what|why|how|which|who|whether|is (?:it|this|there)|are there|describe|explain|analy[sz]e|identify|translate|summari[sz]e|read|tell me|check|review)\b/i.test(text);
}
export function instructsImageChange(text) {
  return /把|让|给|帮我|请|麻烦|弄|处理|合成|拼|融合|合并|组合|变|改|换|[Pp]图|修|美化|加|去|删|调|做成|转成|风格|卡通|动漫|水彩|油画|素描|像素|手绘|吉卜力|老照片|上色|高清|扩图|延展|虚化|模糊|磨皮|瘦|美颜|滤镜|色调|晚霞|日落|夜景|雪景|\b(?:turn|make|convert|combine|merge|blend|collage|style|cartoon|anime|fix|restore|colou?ri[sz]e|enhance|upscale|blur|add|remove|put|replace|swap)\b/i.test(text);
}
// "参考这张图生成一张海报": a new image made from a reference, not at sentence start.
export function requestsReferenceImage(text) {
  return /(?:参考|按照|照着|仿照|根据|模仿|用)[^。！？\n]{0,20}(?:生成|画|做|制作|设计|出)[^。！？\n]{0,20}(?:图|海报|插画|封面|头像|壁纸|图标|logo)|\b(?:based on|using|like) (?:this|the) (?:image|photo|picture)\b.{0,40}\b(?:generate|create|draw|make)\b/i.test(text);
}
// Several photos are combined only when the wording says so; otherwise each is
// edited on its own. Mirrored by ImageTaskPlan.combinesImages on the phone.
export function combinesImages(text) {
  return /合成|拼接|拼成|拼在|拼到|融合|合并|组合|结合|合到|放到|放进|放在|贴到|换到|参考|照着|按照.{0,8}风格|风格.{0,6}(?:换成|用|参考)|第[一二三四五六七八1-8]张.{0,16}第[一二三四五六七八1-8]张|把.{0,12}(?:和|与|跟).{0,12}(?:合|放|拼|融)|\b(?:combine|merge|composite|blend|collage|montage|put .{0,30} into|place .{0,30} (?:in|on|into)|use the (?:first|second|third)|in the style of)\b/i.test(text);
}
