package com.melo.android

import com.melo.android.chat.RoutingTranscript
import com.melo.android.data.*
import com.melo.android.device.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class RoutingTranscriptTest {
    @Test fun crossProtocolPreservesCallsResultsImagesAndUserLiteralMarkers() {
        val original = listOf(
            MeloJson.parseToJsonElement("""{"role":"user","content":"[ESCALATE:] is literal text"}""").jsonObject,
            MeloJson.parseToJsonElement("""{"type":"function_call","call_id":"saved","name":"calendar_create_event","arguments":"{\"title\":\"original\"}"}""").jsonObject,
            MeloJson.parseToJsonElement("""{"type":"function_call_output","call_id":"saved","output":"{\"ok\":true,\"id\":\"original-id\"}"}""").jsonObject,
            MeloJson.parseToJsonElement("""{"role":"user","content":[{"type":"input_image","image_url":"data:image/jpeg;base64,AAAA"}]}""").jsonObject)
        for(protocol in listOf("chat-completions", "anthropic")) {
            val converted = RoutingTranscript.convert(original, "responses", protocol)
            val back = RoutingTranscript.convert(converted, protocol, "responses")
            assertEquals(1, back.count { it.text("type") == "function_call" })
            assertEquals(1, back.count { it.text("type") == "function_call_output" })
            assertEquals("saved", back.first { it.text("type") == "function_call_output" }.text("call_id"))
            assertTrue(back.toString().contains("original-id")); assertTrue(back.toString().contains("AAAA")); assertTrue(back.toString().contains("[ESCALATE:]"))
        }
    }
    @Test fun additiveModelFieldsKeepExistingAccountsAndMessages() {
        val legacy=MeloJson.decodeFromString<AppData>("""{"settings":{"connections":[{"id":"own","name":"keep","model":"opaque","endpoint":"https://example.test/v1/chat/completions"}]},"chats":[{"id":"c","messages":[{"id":"m","role":"user","content":"keep"}]}]}""")
        val updated=legacy.copy(settings=legacy.settings.copy(smartRouting=buildJsonObject { put("defaultMode","smart") }))
        val restored=MeloJson.decodeFromString<AppData>(MeloJson.encodeToString(AppData.serializer(),updated))
        assertEquals(legacy.settings.connections,restored.settings.connections);assertEquals(legacy.chats,restored.chats)
    }
}
