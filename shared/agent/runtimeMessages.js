import { normalizeLocale } from './locale.js';
export const RUNTIME_MESSAGES = {
  "stop": {
    "zh": "本轮已停止（{reason}）。已有操作和回执已保留，尚未确认任务完成；请调整目标或补充信息后继续。",
    "en": "This turn stopped ({reason}). Existing actions and receipts are preserved; task completion is unverified. Please adjust the request or supply more information.",
    "ja": "このターンは停止しました（{reason}）。操作と記録は保存されています。完了は未確認です。依頼を調整するか情報を追加してください。",
    "ko": "이번 실행이 중지되었습니다({reason}). 작업과 기록은 보존되었으며 완료 여부는 확인되지 않았습니다. 요청을 조정하거나 정보를 추가해 주세요.",
    "es": "Este turno se detuvo ({reason}). Las acciones y los registros se conservan; la finalización no está verificada. Ajusta la solicitud o añade información."
  },
  "empty": {
    "zh": "未能生成回复，请重试。",
    "en": "I wasn't able to generate a response for this message. Please try again.",
    "ja": "回答を生成できませんでした。もう一度お試しください。",
    "ko": "답변을 생성하지 못했습니다. 다시 시도해 주세요.",
    "es": "No se pudo generar una respuesta. Inténtalo de nuevo."
  },
  "mediaDenied": {
    "zh": "此 Agent 未开启生成媒体能力。请在 Agent 设置中开启后重试。",
    "en": "Media generation is disabled for this Agent. Enable it in Agent settings and retry.",
    "ja": "この Agent はメディア生成を許可されていません。設定を確認してください。",
    "ko": "이 Agent의 미디어 생성이 꺼져 있습니다. Agent 설정에서 켜 주세요.",
    "es": "La generación multimedia está desactivada para este Agent. Actívala en sus ajustes."
  },
  "budget": {
    "zh": "本轮运行预算已用完（{reason}）。已有结果已保留，尚未完成的部分请继续处理。",
    "en": "This turn reached its runtime budget ({reason}). Existing results are preserved; remaining work is incomplete.",
    "ja": "実行予算に達しました（{reason}）。結果は保存され、残りの作業は未完了です。",
    "ko": "실행 예산에 도달했습니다({reason}). 기존 결과는 보존되며 남은 작업은 미완료입니다.",
    "es": "Se alcanzó el presupuesto de ejecución ({reason}). Los resultados se conservan; queda trabajo pendiente."
  },
  "completed": {
    "zh": "已完成",
    "en": "Completed",
    "ja": "完了",
    "ko": "완료",
    "es": "Completado"
  },
  "partial": {
    "zh": "部分完成",
    "en": "Partially completed",
    "ja": "一部完了",
    "ko": "부분 완료",
    "es": "Parcialmente completado"
  },
  "blocked": {
    "zh": "受阻",
    "en": "Blocked",
    "ja": "進行不可",
    "ko": "진행 불가",
    "es": "Bloqueado"
  },
  "needs_user": {
    "zh": "等待补充",
    "en": "Needs your input",
    "ja": "入力待ち",
    "ko": "입력 대기",
    "es": "Necesita tu respuesta"
  },
  "cancelled": {
    "zh": "已取消",
    "en": "Cancelled",
    "ja": "キャンセル済み",
    "ko": "취소됨",
    "es": "Cancelado"
  },
  "budget_exhausted": {
    "zh": "预算已用完",
    "en": "Budget exhausted",
    "ja": "予算を使い切りました",
    "ko": "예산 소진",
    "es": "Presupuesto agotado"
  },
  "delivered": {
    "zh": "回答已交付",
    "en": "Answer delivered",
    "ja": "回答を提供しました",
    "ko": "답변 전달됨",
    "es": "Respuesta entregada"
  },
  "unsourced": {
    "zh": "已回答；未检索来源",
    "en": "Answered without retrieving sources",
    "ja": "回答済み・情報源未検索",
    "ko": "답변 완료 · 출처 검색 안 함",
    "es": "Respuesta sin consultar fuentes"
  },
  "checkBudget": {
    "zh": "回答已保留；剩余预算不足，尚未完成交付检查",
    "en": "Answer preserved; insufficient budget to check delivery",
    "ja": "回答は保存済み・予算不足で完了確認できません",
    "ko": "답변 보존 · 예산 부족으로 완료 확인 불가",
    "es": "Respuesta conservada; presupuesto insuficiente para verificar la entrega"
  },
  "checkScope": {
    "zh": "回答已保留；内容超过本次核对范围，完成情况未确认",
    "en": "Answer preserved; content exceeds the scope of this delivery check",
    "ja": "回答は保存済み・確認範囲を超えています",
    "ko": "답변 보존 · 확인 범위 초과",
    "es": "Respuesta conservada; el contenido supera el alcance de la verificación"
  },
  "checkUnavailable": {
    "zh": "回答已保留；交付检查未能完成，结论待核对",
    "en": "Answer preserved; delivery check unavailable, conclusions remain unchecked",
    "ja": "回答は保存済み・完了確認は未実施です",
    "ko": "답변 보존 · 완료 검증 불가",
    "es": "Respuesta conservada; no se pudo verificar la entrega"
  },
  "supported": {
    "zh": "已核对交付要求与执行依据；事实未独立复核",
    "en": "Delivery checked against recorded evidence; facts not independently verified",
    "ja": "要件と実行記録を確認済み・事実は独立検証していません",
    "ko": "요구 사항과 실행 기록 확인 · 사실은 독립 검증되지 않음",
    "es": "Entrega comprobada con los registros; hechos no verificados de forma independiente"
  },
  "sourcesRead": {
    "zh": "已读取相关来源；结论未独立核实",
    "en": "Relevant sources read; conclusions are not independently verified",
    "ja": "関連情報源を確認済み・結論は独立検証していません",
    "ko": "관련 출처 확인 · 결론은 독립 검증되지 않음",
    "es": "Fuentes relevantes consultadas; conclusiones no verificadas de forma independiente"
  },
  "verified": {
    "zh": "已核对目标状态",
    "en": "Target state verified",
    "ja": "目標の状態を確認済み",
    "ko": "목표 상태 확인됨",
    "es": "Estado del objetivo verificado"
  },
  "unverified": {
    "zh": "尚无目标完成证据",
    "en": "Goal completion is unverified",
    "ja": "目標達成は未確認です",
    "ko": "목표 완료 미확인",
    "es": "Finalización del objetivo no verificada"
  },
  "unknown": {
    "zh": "完成状态未知",
    "en": "Completion unknown",
    "ja": "完了状態不明",
    "ko": "완료 상태 알 수 없음",
    "es": "Finalización desconocida"
  },
  "teamDone": {
    "zh": "已汇总成员交付；详见各成员回执",
    "en": "Member deliveries summarized; see individual receipts",
    "ja": "メンバーの成果を集約済み・各記録をご確認ください",
    "ko": "멤버 결과 요약 완료 · 개별 기록 참조",
    "es": "Entregas resumidas; consulta los registros de cada miembro"
  },
  "teamPartial": {
    "zh": "团队尚未全部完成；详见各成员回执",
    "en": "Team delivery is incomplete; see member receipts",
    "ja": "チームの作業は未完了です・各記録をご確認ください",
    "ko": "팀 작업 미완료 · 멤버 기록 참조",
    "es": "Entrega del equipo incompleta; consulta los registros"
  },
  "stage.compact": {
    "zh": "压缩早期对话",
    "en": "Condensing earlier conversation",
    "ja": "以前の会話を圧縮",
    "ko": "이전 대화 압축",
    "es": "Condensando la conversación anterior"
  },
  "stage.condense": {
    "zh": "工具结果已压缩",
    "en": "Tool results condensed",
    "ja": "ツール結果を圧縮済み",
    "ko": "도구 결과 압축됨",
    "es": "Resultados de herramientas condensados"
  },
  "stage.budget": {
    "zh": "运行预算已用完",
    "en": "Runtime budget exhausted",
    "ja": "実行予算を使い切りました",
    "ko": "실행 예산 소진",
    "es": "Presupuesto de ejecución agotado"
  },
  "stage.stopped": {
    "zh": "执行已停止",
    "en": "Execution stopped",
    "ja": "実行停止",
    "ko": "실행 중지",
    "es": "Ejecución detenida"
  },
  "stage.format": {
    "zh": "整理回答与引用",
    "en": "Formatting reply and citations",
    "ja": "回答と引用を整理",
    "ko": "답변과 인용 정리",
    "es": "Organizando respuesta y citas"
  },
  "stage.delivery": {
    "zh": "核对任务交付",
    "en": "Checking task delivery",
    "ja": "タスクの完了を確認",
    "ko": "작업 완료 확인",
    "es": "Verificando la entrega"
  },
  "stage.vision": {
    "zh": "图片输入准备",
    "en": "Preparing image input",
    "ja": "画像入力を準備",
    "ko": "이미지 입력 준비",
    "es": "Preparando la entrada de imagen"
  },
  "stage.degraded": {
    "zh": "对话摘要降级",
    "en": "Conversation summary fallback",
    "ja": "会話要約を代替方式で作成",
    "ko": "대화 요약 대체 방식 사용",
    "es": "Resumen de conversación alternativo"
  },
  "stage.restored": {
    "zh": "对话摘要已恢复",
    "en": "Conversation summary restored",
    "ja": "会話要約を復元済み",
    "ko": "대화 요약 복구됨",
    "es": "Resumen de conversación restaurado"
  },
  "stage.history": {
    "zh": "早期话题原文",
    "en": "Earlier topic excerpts",
    "ja": "以前のトピックの抜粋",
    "ko": "이전 주제 발췌",
    "es": "Extractos de temas anteriores"
  },
  "stage.knowledge": {
    "zh": "知识片段检索",
    "en": "Retrieving knowledge excerpts",
    "ja": "資料の抜粋を検索",
    "ko": "지식 발췌 검색",
    "es": "Buscando fragmentos de conocimiento"
  },
  "stage.supplement": {
    "zh": "收到补充",
    "en": "Additional input received",
    "ja": "追加入力を受信",
    "ko": "추가 입력 수신",
    "es": "Información adicional recibida"
  },
  "stage.routing": {
    "zh": "智能选模",
    "en": "Smart model selection",
    "ja": "モデルの自動選択",
    "ko": "스마트 모델 선택",
    "es": "Selección inteligente de modelo"
  },
  "stage.imageCheck": {
    "zh": "核对图片结果",
    "en": "Checking image result",
    "ja": "画像の結果を確認",
    "ko": "이미지 결과 확인",
    "es": "Verificando el resultado de imagen"
  },
  "workspaceRequired": {
    "zh": "此操作需要明确的工作目录。",
    "en": "This operation needs an explicit working directory.",
    "ja": "この操作には作業フォルダが必要です。",
    "ko": "이 작업에는 작업 폴더가 필요합니다.",
    "es": "Esta operación necesita una carpeta de trabajo."
  },
  "operationReplay": {
    "zh": "复用同一次调用的执行记录；当前效果仍需核对。",
    "en": "Reusing the receipt for this invocation; its current effects still need checking.",
    "ja": "同じ呼び出しの記録を再利用します。現在の結果は要確認です。",
    "ko": "같은 호출의 기록을 재사용합니다. 현재 결과는 확인이 필요합니다.",
    "es": "Se reutiliza el registro de esta llamada; sus efectos actuales aún deben comprobarse."
  },
  "operationUncertain": {
    "zh": "此操作已有结果不明的执行记录。请检查实际效果；为避免重复副作用，本次未自动重试。",
    "en": "This operation has an uncertain prior result. Check its effects; it was not retried to avoid duplicate changes.",
    "ja": "前回の結果が不明です。重複操作を避けるため再試行していません。結果を確認してください。",
    "ko": "이전 결과가 불확실합니다. 중복 변경을 막기 위해 재시도하지 않았습니다. 실제 결과를 확인해 주세요.",
    "es": "El resultado anterior es incierto. Comprueba sus efectos; no se reintentó para evitar cambios duplicados."
  },
  "voiceGuild": {
    "zh": "只能在服务器的文字频道里让我加入语音（DM 里没有语音频道的概念）。",
    "en": "Ask me to join from a server text channel; direct messages have no voice channel.",
    "ja": "サーバーのテキストチャンネルから音声参加を依頼してください。",
    "ko": "서버의 텍스트 채널에서 음성 참여를 요청해 주세요.",
    "es": "Pídeme que entre desde un canal de texto del servidor."
  },
  "voiceGateway": {
    "zh": "登入 Discord Gateway 失败：{error}",
    "en": "Could not connect to Discord Gateway: {error}",
    "ja": "Discord Gateway に接続できません: {error}",
    "ko": "Discord Gateway 연결 실패: {error}",
    "es": "No se pudo conectar con Discord Gateway: {error}"
  },
  "voiceServer": {
    "zh": "找不到这个服务器：{error}",
    "en": "Server unavailable: {error}",
    "ja": "サーバーを利用できません: {error}",
    "ko": "서버를 사용할 수 없습니다: {error}",
    "es": "Servidor no disponible: {error}"
  },
  "voiceMember": {
    "zh": "我在这个服务器里找不到你的成员资料。",
    "en": "I could not find your membership in this server.",
    "ja": "このサーバーのメンバー情報が見つかりません。",
    "ko": "이 서버에서 회원 정보를 찾지 못했습니다.",
    "es": "No encontré tu información de miembro en este servidor."
  },
  "voiceFirst": {
    "zh": "你得先进一个语音频道，我才能跟着进去。",
    "en": "Join a voice channel first so I can follow.",
    "ja": "先に音声チャンネルに参加してください。",
    "ko": "먼저 음성 채널에 참여해 주세요.",
    "es": "Entra primero en un canal de voz para que pueda seguirte."
  },
  "voiceAlready": {
    "zh": "我已经在这个语音频道里了。说话就行。",
    "en": "I am already in this voice channel. You can speak now.",
    "ja": "すでにこの音声チャンネルにいます。話しかけてください。",
    "ko": "이미 이 음성 채널에 있습니다. 말씀해 주세요.",
    "es": "Ya estoy en este canal de voz. Puedes hablar."
  },
  "voiceFailed": {
    "zh": "加入语音频道失败：{error}",
    "en": "Could not join the voice channel: {error}",
    "ja": "音声チャンネルへの参加に失敗しました: {error}",
    "ko": "음성 채널 참여 실패: {error}",
    "es": "No pude entrar al canal de voz: {error}"
  },
  "voiceJoined": {
    "zh": "已加入 #{name}。说话时叫我的名字，或继续上一段对话即可。",
    "en": "Joined #{name}. Say my name when speaking, or continue our conversation.",
    "ja": "#{name} に参加しました。名前を呼ぶか、会話を続けてください。",
    "ko": "#{name}에 참여했습니다. 이름을 부르거나 대화를 이어 주세요.",
    "es": "Entré en #{name}. Di mi nombre al hablar o continúa nuestra conversación."
  },
  "voiceNone": {
    "zh": "没有要离开的语音频道。",
    "en": "There is no voice channel to leave.",
    "ja": "退出する音声チャンネルはありません。",
    "ko": "나갈 음성 채널이 없습니다.",
    "es": "No hay un canal de voz del que salir."
  },
  "voiceAbsent": {
    "zh": "我不在语音频道里。",
    "en": "I am not in a voice channel.",
    "ja": "音声チャンネルに参加していません。",
    "ko": "음성 채널에 참여하고 있지 않습니다.",
    "es": "No estoy en un canal de voz."
  },
  "voiceLeft": {
    "zh": "已离开语音频道。",
    "en": "Left the voice channel.",
    "ja": "音声チャンネルを退出しました。",
    "ko": "음성 채널에서 나왔습니다.",
    "es": "Salí del canal de voz."
  },
  "stage.handoff": {
    "zh": "交接记录",
    "en": "Handoff record",
    "ja": "引き継ぎ記録",
    "ko": "인계 기록",
    "es": "Registro de traspaso"
  },
  "stage.save": {
    "zh": "保存回答",
    "en": "Saving answer",
    "ja": "回答を保存",
    "ko": "답변 저장",
    "es": "Guardando respuesta"
  },
  "stage.member": {
    "zh": "成员执行",
    "en": "Member execution",
    "ja": "メンバーの実行",
    "ko": "멤버 실행",
    "es": "Ejecución del miembro"
  },
  "stage.teamBudget": {
    "zh": "团队预算被父预算封顶",
    "en": "Team budget limited by parent run",
    "ja": "親実行によるチーム予算制限",
    "ko": "상위 실행의 팀 예산 제한",
    "es": "Presupuesto del equipo limitado por la ejecución principal"
  },
  "output.degraded": {
    "zh": "摘要模型不可用，已使用抽取式摘要；后续轮次会自动重试。",
    "en": "The summary model is unavailable. An extractive summary is in use; later turns will retry.",
    "ja": "要約モデルを利用できないため抽出型要約を使っています。後で再試行します。",
    "ko": "요약 모델을 사용할 수 없어 추출 요약을 사용합니다. 이후 다시 시도합니다.",
    "es": "El modelo de resumen no está disponible. Se usa un resumen extractivo; se reintentará después."
  },
  "output.restored": {
    "zh": "摘要模型恢复可用，已用完整摘要替换抽取式摘要。",
    "en": "The summary model recovered; the extractive summary was replaced.",
    "ja": "要約モデルが復旧し、要約を置き換えました。",
    "ko": "요약 모델이 복구되어 추출 요약을 교체했습니다.",
    "es": "El modelo de resumen se recuperó y reemplazó el resumen extractivo."
  },
  "output.aborted": {
    "zh": "已中止。",
    "en": "Stopped.",
    "ja": "停止しました。",
    "ko": "중지되었습니다.",
    "es": "Detenido."
  },
  "output.condensed": {
    "zh": "早期工具输出已压缩以继续本轮。",
    "en": "Earlier tool outputs were condensed to continue this turn.",
    "ja": "このターンを続けるため以前のツール出力を圧縮しました。",
    "ko": "이번 실행을 계속하기 위해 이전 도구 출력을 압축했습니다.",
    "es": "Se condensaron las salidas anteriores de herramientas para continuar."
  },
  "output.format": {
    "zh": "处理返回文字、引用与消息格式",
    "en": "Processing text, citations and message formatting",
    "ja": "本文・引用・書式を整理",
    "ko": "본문, 인용 및 서식 처리",
    "es": "Procesando texto, citas y formato"
  },
  "output.formatted": {
    "zh": "回答格式与引用整理完成",
    "en": "Answer formatting and citations ready",
    "ja": "回答の書式と引用を整理しました",
    "ko": "답변 서식과 인용 정리 완료",
    "es": "Formato y citas de la respuesta listos"
  },
  "stage.ocr": {
    "zh": "OCR 交叉核对",
    "en": "OCR cross-check",
    "ja": "OCR照合",
    "ko": "OCR 교차 확인",
    "es": "Verificación OCR"
  },
  "stage.reference": {
    "zh": "分析参考图",
    "en": "Analyzing reference image",
    "ja": "参照画像を分析",
    "ko": "참조 이미지 분석",
    "es": "Analizando imagen de referencia"
  },
  "output.compactStart": {
    "zh": "正在压缩最早的 {count} 条消息。",
    "en": "Condensing the earliest {count} messages.",
    "ja": "最初の {count} 件を圧縮しています。",
    "ko": "이전 메시지 {count}개를 압축합니다.",
    "es": "Condensando los primeros {count} mensajes."
  },
  "output.compactFailure": {
    "zh": "摘要连续失败 {count} 次，本轮保留原始历史。",
    "en": "Summary failed {count} times; this turn retains the original history.",
    "ja": "要約が {count} 回失敗したため、元の履歴を保持します。",
    "ko": "요약이 {count}회 실패하여 원본 기록을 유지합니다.",
    "es": "El resumen falló {count} veces; se conserva el historial original."
  },
  "output.compactDone": {
    "zh": "已将 {count} 条消息压成一张话题卡。",
    "en": "Condensed {count} messages into a topic card.",
    "ja": "{count} 件のメッセージを話題カードに要約しました。",
    "ko": "메시지 {count}개를 주제 카드로 요약했습니다.",
    "es": "Se condensaron {count} mensajes en una tarjeta temática."
  },
  "output.budget": {
    "zh": "本轮达到运行预算：{reason}；模型请求 {calls} 次，输入 {tokens} token，工具 {tools} 次。",
    "en": "Runtime budget reached: {reason}; {calls} model requests, {tokens} input tokens, {tools} tool calls.",
    "ja": "実行予算に到達: {reason}。モデル {calls} 回、入力 {tokens} トークン、ツール {tools} 回。",
    "ko": "실행 예산 도달: {reason}. 모델 {calls}회, 입력 {tokens}토큰, 도구 {tools}회.",
    "es": "Límite alcanzado: {reason}; {calls} solicitudes, {tokens} tokens de entrada, {tools} llamadas a herramientas."
  }
};
export function runtimeMessage(id, locale = 'en', params = {}) {
  const row = RUNTIME_MESSAGES[id];
  const text = row?.[normalizeLocale(locale)] || row?.en || id;
  return text.replace(/\{(\w+)\}/g, (match, key) => Object.hasOwn(params, key) ? String(params[key]) : match);
}
export function executionMessage(event) {
  if (event?.kind !== 'pipeline') return event;
  const entry = Object.entries(RUNTIME_MESSAGES).find(([id, row]) => id.startsWith('stage.') && row.zh === event.name);
  const authoredOutput = entry && ['stage.compact','stage.condense','stage.budget','stage.stopped','stage.format','stage.degraded','stage.restored'].includes(entry[0]) || /^(?:compact:|tool-chain:condense:|reply:format)/.test(event.id || '');
  const output = authoredOutput && Object.entries(RUNTIME_MESSAGES).find(([id, row]) => id.startsWith('output.') && row.zh === event.output);
  return { ...event, ...(entry ? { messageId: entry[0], messageParams: {} } : {}), ...(output ? { outputMessageId: output[0], outputMessageParams: {} } : {}) };
}

export function runtimeStageName(stage, locale) {
  const value = executionMessage({ ...stage, kind: 'pipeline' });
  return value?.messageId && RUNTIME_MESSAGES[value.messageId] ? runtimeMessage(value.messageId, locale, value.messageParams) : stage?.name || '';
}

export function runtimeStageOutput(stage, locale) {
  const value = executionMessage({ ...stage, kind: 'pipeline' });
  return value?.outputMessageId && RUNTIME_MESSAGES[value.outputMessageId] ? runtimeMessage(value.outputMessageId, locale, value.outputMessageParams) : stage?.output || '';
}
