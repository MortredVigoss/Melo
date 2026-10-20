package com.melo.android.ui

import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.*
import androidx.compose.ui.text.font.*
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import com.melo.android.core.*
import com.melo.android.data.text
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.*

/** Same parser packaged for Node/iOS; Compose owns presentation, not Markdown rules. */
@Composable fun ReplyContent(text: String) {
    val context = LocalContext.current.applicationContext
    val document by produceState<JsonArray?>(null, text) {
        try { value = ReplyDocuments.parse(context, text) }
        catch (error: Exception) { if (error is CancellationException) throw error }
    }
    val blocks = document
    if (blocks == null) { Text(text, style = MaterialTheme.typography.bodyLarge); return }
    Column(Modifier.fillMaxWidth().testTag("reply-markdown"), verticalArrangement = Arrangement.spacedBy(9.dp)) {
        for (item in blocks) {
            val block = item.jsonObject
            val content = annotated(block["inline"] as? JsonArray)
            when (block.text("type")) {
                "code" -> Column(Modifier.fillMaxWidth().background(MeloGold.copy(alpha = .06f)).padding(10.dp)) {
                    Text(block.text("language").ifBlank { "代码" }, style = MaterialTheme.typography.labelSmall, color = MeloMuted)
                    Text(block.text("text"), fontFamily = FontFamily.Monospace, modifier = Modifier.horizontalScroll(rememberScrollState()).padding(top = 6.dp), softWrap = false)
                }
                "heading" -> Text(content, style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(top = 3.dp))
                "quote" -> Row { Box(Modifier.width(2.dp).heightIn(min = 28.dp).background(MeloGold)); Text(content, color = MeloMuted, modifier = Modifier.padding(start = 10.dp)) }
                "list" -> Row(Modifier.padding(start = ((block["indent"]?.jsonPrimitive?.intOrNull ?: 0).coerceIn(0, 24) * 3).dp)) {
                    val checked = block["checked"]?.takeUnless { it == JsonNull }?.jsonPrimitive?.booleanOrNull
                    Text(if (checked == null) block.text("marker") else if (checked) "[x]" else "[ ]", color = MeloGold, modifier = Modifier.padding(end = 9.dp))
                    Text(content, modifier = Modifier.weight(1f))
                }
                "table" -> Column(Modifier.testTag("reply-table").horizontalScroll(rememberScrollState()).border(1.dp, MeloGold.copy(alpha = .2f))) {
                    for ((index, row) in (block["cells"] as? JsonArray).orEmpty().withIndex()) Row {
                        for (cell in row.jsonArray) Text(annotated(cell.jsonArray), modifier = Modifier.width(190.dp).padding(10.dp), color = if (index == 0) MeloGold else MaterialTheme.colorScheme.onSurface, fontWeight = if (index == 0) FontWeight.SemiBold else FontWeight.Normal)
                    }
                }
                else -> Text(content, style = MaterialTheme.typography.bodyLarge)
            }
        }
    }
}

@Composable private fun annotated(tokens: JsonArray?): AnnotatedString = buildAnnotatedString {
    for (item in tokens.orEmpty()) {
        val span = item.jsonObject
        val code = span["code"]?.jsonPrimitive?.booleanOrNull == true
        val style = SpanStyle(fontWeight = if (span["bold"]?.jsonPrimitive?.booleanOrNull == true) FontWeight.Bold else null,
            fontStyle = if (span["italic"]?.jsonPrimitive?.booleanOrNull == true) FontStyle.Italic else null,
            textDecoration = if (span["strike"]?.jsonPrimitive?.booleanOrNull == true) TextDecoration.LineThrough else null,
            fontFamily = if (code) FontFamily.Monospace else null,
            background = if (code) MeloGold.copy(alpha = .10f) else androidx.compose.ui.graphics.Color.Unspecified)
        withStyle(style) {
            if (span.text("url").isNotBlank()) withLink(LinkAnnotation.Url(span.text("url"), TextLinkStyles(SpanStyle(color = MeloGold, textDecoration = TextDecoration.Underline)))) { append(span.text("text")) }
            else append(span.text("text"))
        }
    }
}

private object ReplyDocuments {
    private val mutex = Mutex()
    private val cache = LinkedHashMap<String, JsonArray>()
    suspend fun parse(context: android.content.Context, text: String): JsonArray = mutex.withLock {
        cache[text]?.let { return@withLock it }
        val parsed = SharedCoreRuntime.open(context).use { it.value("replyPresentation", buildJsonObject { put("text", text) }).jsonArray }
        if (cache.size >= 48) cache.remove(cache.keys.first())
        cache[text] = parsed
        parsed
    }
}
