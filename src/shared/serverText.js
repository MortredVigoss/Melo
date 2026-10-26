import { normalizeLocale } from '../../shared/agent/locale.js';
import { runtimeMessage, RUNTIME_MESSAGES } from '../../shared/agent/runtimeMessages.js';
import { currentRequestContext } from '../runtime/requestScope.js';

// Authored replies/errors only. Never pass user names or model prose as keys.
export const SERVER_TEXT = {
  "agentMigration": {
    "zh": "请先在桌面完成 Agent「{name}」的能力迁移，再启动协作。",
    "en": "Complete the capability migration for Agent “{name}” on the desktop before starting collaboration.",
    "ja": "連携を開始する前にデスクトップで Agent「{name}」の権限移行を完了してください。",
    "ko": "협업 전에 데스크톱에서 Agent ‘{name}’의 기능 이전을 완료해 주세요.",
    "es": "Completa la migración de capacidades del Agent «{name}» en el escritorio antes de colaborar."
  },
  "delegationDenied": {
    "zh": "目标 Agent 未授权、已在调用链中或超过委派深度。",
    "en": "The target Agent is unauthorized, already in the call chain, or beyond the delegation depth limit.",
    "ja": "対象 Agent は未許可、呼び出し中、または委任の深さ上限を超えています。",
    "ko": "대상 Agent가 허용되지 않았거나 호출 중이거나 위임 깊이 제한을 초과했습니다.",
    "es": "El Agent no está autorizado, ya está en la cadena o supera el límite de delegación."
  },
  "noActiveReply": {
    "zh": "这个对话当前没有进行中的回复。",
    "en": "This conversation has no reply in progress.",
    "ja": "この会話には処理中の回答がありません。",
    "ko": "이 대화에는 진행 중인 답변이 없습니다.",
    "es": "Esta conversación no tiene una respuesta en curso."
  },
  "videoMissing": {
    "zh": "视频不存在。",
    "en": "Video not found.",
    "ja": "動画が見つかりません。",
    "ko": "동영상을 찾을 수 없습니다.",
    "es": "No se encontró el vídeo."
  },
  "attachmentMissing": {
    "zh": "附件不存在。",
    "en": "Attachment not found.",
    "ja": "添付ファイルが見つかりません。",
    "ko": "첨부 파일을 찾을 수 없습니다.",
    "es": "No se encontró el archivo adjunto."
  },
  "localCapabilityOnly": {
    "zh": "能力放宽只能在本机桌面设置中确认。",
    "en": "Capability expansion must be confirmed in local desktop settings.",
    "ja": "権限の拡張はローカルのデスクトップ設定で確認してください。",
    "ko": "기능 확대는 로컬 데스크톱 설정에서 확인해야 합니다.",
    "es": "La ampliación de capacidades debe confirmarse en los ajustes locales del escritorio."
  },
  "syncLimit": {
    "zh": "同步资料超过 8 MiB 容量，原记录已保留。请先导出备份并减少同步资料。",
    "en": "Sync data exceeds 8 MiB. Existing records were preserved. Export a backup and reduce the synced data.",
    "ja": "同期データが 8 MiB を超えています。既存の記録は保持されています。バックアップを出力して同期内容を減らしてください。",
    "ko": "동기화 데이터가 8 MiB를 초과했습니다. 기존 기록은 보존되었습니다. 백업한 후 동기화 데이터를 줄여 주세요.",
    "es": "Los datos superan 8 MiB. Se conservaron los registros. Exporta una copia y reduce los datos sincronizados."
  },
  "embeddingOffline": {
    "zh": "嵌入服务未响应；当前使用关键词检索。",
    "en": "The embedding service is unavailable; keyword search is in use.",
    "ja": "埋め込みサービスが応答しないためキーワード検索を使用しています。",
    "ko": "임베딩 서비스가 응답하지 않아 키워드 검색을 사용합니다.",
    "es": "El servicio de embeddings no responde; se usa búsqueda por palabras clave."
  },
  "embeddingDimensions": {
    "zh": "模型报告 {actual} 维，索引需要 {expected} 维。",
    "en": "The model reports {actual} dimensions; the index requires {expected}.",
    "ja": "モデルは {actual} 次元、索引には {expected} 次元が必要です。",
    "ko": "모델은 {actual}차원이며 인덱스에는 {expected}차원이 필요합니다.",
    "es": "El modelo indica {actual} dimensiones; el índice necesita {expected}."
  },
  "embeddingChanged": {
    "zh": "嵌入模型已变化，需要安全重建索引。",
    "en": "The embedding model changed; the index needs a safe rebuild.",
    "ja": "埋め込みモデルが変更されたため索引の安全な再構築が必要です。",
    "ko": "임베딩 모델이 변경되어 인덱스를 안전하게 다시 만들어야 합니다.",
    "es": "El modelo de embeddings cambió; hay que reconstruir el índice de forma segura."
  },
  "embeddingMissing": {
    "zh": "部分记忆尚未建立语义索引。",
    "en": "Some memories are not yet semantically indexed.",
    "ja": "一部の記憶はまだ意味索引に登録されていません。",
    "ko": "일부 기억에 의미 인덱스가 아직 없습니다.",
    "es": "Algunos recuerdos aún no tienen índice semántico."
  },
  "oauthNotSaved": {
    "zh": "授权未保存，连接可能已变更或授权服务不可用。请返回 Melo 重试。",
    "en": "Authorization was not saved. The connection may have changed or the authorization service may be unavailable. Return to Melo and retry.",
    "ja": "認証を保存できませんでした。接続が変更されたか認証サービスを利用できない可能性があります。Melo で再試行してください。",
    "ko": "인증을 저장하지 못했습니다. 연결이 변경되었거나 인증 서비스를 사용할 수 없습니다. Melo에서 다시 시도해 주세요.",
    "es": "No se guardó la autorización. La conexión puede haber cambiado o el servicio no estar disponible. Vuelve a Melo e inténtalo otra vez."
  }
};
export function serverText(id, params = {}, locale) {
  const context = currentRequestContext();
  const language = normalizeLocale(locale || context?.replyLocale || context?.config?.replyLanguage || context?.interfaceLanguage);
  if (RUNTIME_MESSAGES[id]) return runtimeMessage(id, language, params);
  const row = SERVER_TEXT[id];
  return (row?.[language] || row?.en || id).replace(/\{(\w+)\}/g, (match, key) => Object.hasOwn(params, key) ? String(params[key]) : match);
}
