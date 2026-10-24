// Additive intent recognition for supported interface languages. Explicit UI
// actions remain authoritative; discussion/negation never authorizes an edit.
export function multilingualImageAction(text, hasInputImage = false) {
  const value = String(text || '').replace(/```[\s\S]*?```|“[^”]*”|「[^」]*」|"[^"]*"/g, '').trim();
  if (/(?:しないで|しない|禁止|やめて|하지\s*마|하지\s*않|금지)|\b(?:no|nunca|sin)\b|(?:方法|やり方|チュートリアル|하는\s*법|방법|튜토리얼)|\b(?:cómo|como|tutorial|código|prompt)\b/iu.test(value)) return null;
  if (hasInputImage && /(?:背景|写真|画像).{0,18}(?:変えて|変更して|消して|削除して|明るくして|編集して)|(?:배경|사진|이미지).{0,18}(?:바꿔|변경해|지워|삭제해|밝게|편집해)|\b(?:cambia|cambiar|edita|editar|elimina|eliminar|reemplaza|recorta)\b.{0,35}\b(?:fondo|foto|imagen|color)\b/iu.test(value)) return 'edit';
  if (/(?:描いて|描画して)|(?:画像|写真|イラスト|ポスター).{0,18}(?:生成して|作って)|(?:그려\s*줘|그려주세요)|(?:이미지|사진|그림|포스터).{0,18}(?:생성해|만들어)|\b(?:dibuja|dibuja[r]?|genera|crea|pinta)\b.{0,40}\b(?:imagen|foto|ilustración|póster|gato|perro|paisaje)\b/iu.test(value)) return 'generate';
  return null;
}
