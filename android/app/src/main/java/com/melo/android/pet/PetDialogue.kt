package com.melo.android.pet

import com.melo.android.data.AppData

data class PetReply(val status: String, val text: String, val error: String?) {
    val ok get() = status == "completed" && text.isNotBlank()
}

/** Text helpers for the floating bubble and the system reader; pure so the gate can check them on the JVM. */
object PetDialogue {
    const val PREVIEW_LIMIT = 80
    const val PREVIEW_SUFFIX = "…（完整回复在 Melo 里）"

    /** Reduces Markdown to something a voice can read: no fences, link targets, heading or list markers. */
    fun speechText(markdown: String): String {
        var text = markdown.replace("\r\n", "\n")
        text = Regex("```[\\s\\S]*?```").replace(text, "（代码略）")
        text = Regex("!\\[[^\\]]*]\\([^)]*\\)").replace(text, "")
        text = Regex("\\[([^\\]]+)]\\([^)]*\\)").replace(text) { it.groupValues[1] }
        text = Regex("<[^>\\n]{1,80}>").replace(text, "")
        text = Regex("^\\s{0,3}#{1,6}\\s+", RegexOption.MULTILINE).replace(text, "")
        text = Regex("^\\s*[-*+]\\s+", RegexOption.MULTILINE).replace(text, "")
        text = Regex("^\\s*\\d+[.)]\\s+", RegexOption.MULTILINE).replace(text, "")
        text = Regex("^\\s*>\\s?", RegexOption.MULTILINE).replace(text, "")
        text = Regex("^\\s*\\|?\\s*:?-{2,}:?\\s*(\\|\\s*:?-{2,}:?\\s*)*\\|?\\s*$", RegexOption.MULTILINE).replace(text, "")
        text = text.replace("|", "，")
        text = Regex("`([^`]*)`").replace(text) { it.groupValues[1] }
        text = Regex("(\\*\\*|__)(.+?)\\1").replace(text) { it.groupValues[2] }
        text = Regex("(?<![\\w*])([*_])([^*_\\n]+?)\\1(?![\\w*])").replace(text) { it.groupValues[2] }
        text = Regex("[ \\t]+").replace(text, " ")
        text = Regex("\\n{2,}").replace(text, "\n")
        return text.trim()
    }

    /** Short bubble text: the beginning of the reply, with a pointer to the app when it was cut. */
    fun bubblePreview(reply: String, limit: Int = PREVIEW_LIMIT): String {
        val plain = speechText(reply).replace('\n', ' ').trim()
        if (plain.isEmpty()) return ""
        if (plain.length <= limit) return plain
        return plain.take(limit).trimEnd() + PREVIEW_SUFFIX
    }

    /** Outcome of a chat run once the engine has finished it; null while the run is still running or unknown. */
    fun replyOutcome(data: AppData, chatId: String, runId: String): PetReply? {
        val run = data.runs.find { it.id == runId } ?: return null
        if (run.status == "running") return null
        val chat = data.chats.find { it.id == chatId }
        val message = chat?.messages?.lastOrNull { it.role == "assistant" && it.runId == runId }
        return PetReply(run.status, message?.content ?: run.partial, run.error)
    }

    fun failureText(reply: PetReply?): String = when {
        reply == null -> "这次没收到回复，再试一次吧。"
        reply.status == "cancelled" -> "这次请求取消了。"
        !reply.error.isNullOrBlank() -> reply.error
        else -> "这次没收到回复，再试一次吧。"
    }
}
