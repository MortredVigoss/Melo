package com.melo.android

import android.os.Build
import androidx.test.core.app.ApplicationProvider
import com.melo.android.chat.SharedChatAgent
import com.melo.android.core.*
import com.melo.android.data.*
import com.melo.android.data.Connection
import com.melo.android.network.ModelClient
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import okhttp3.mockwebserver.*
import org.junit.*
import org.junit.Assert.*
import java.io.File
import java.security.MessageDigest
import java.util.concurrent.TimeUnit

class LoopTraceFlowTest {
    private val app get() = ApplicationProvider.getApplicationContext<MeloApplication>()
    private var before = emptySet<String>()
    private val base get() = File(app.filesDir, "traces")
    @Before fun fixtureOnly() = runBlocking {
        Assume.assumeTrue(Build.FINGERPRINT.contains("generic") || Build.MODEL.contains("sdk_gphone"))
        app.engine.initialize().join()
        before = base.listFiles()?.map { it.name }?.toSet().orEmpty()
    }
    @After fun cleanup() { base.listFiles()?.filter { it.name !in before }?.forEach { it.deleteRecursively() } }
    private suspend fun captured(): Pair<File,List<JsonObject>> {
        val directory = withTimeout(15_000) {
            var result: File? = null
            while (result == null) { result = base.listFiles()?.firstOrNull { it.name !in before && File(it,"manifest.json").exists() }; if (result == null) delay(50) }
            result
        }
        val rows = File(directory,"events.jsonl").readLines().filter(String::isNotBlank).map { MeloJson.parseToJsonElement(it).jsonObject }
        val manifest = MeloJson.parseToJsonElement(File(directory,"manifest.json").readText()).jsonObject
        assertTrue(manifest.toString(),manifest["complete"]!!.jsonPrimitive.boolean)
        assertEquals(rows.size,rows.map { it.text("eventId") }.toSet().size)
        assertEquals((1..rows.size).toList(),rows.map { it["sequence"]!!.jsonPrimitive.int })
        for (row in rows) row["data"]!!.jsonObject["contentRef"]?.let { ref ->
            val artifact = File(directory,ref.jsonPrimitive.content)
            assertTrue(artifact.exists())
            val hash = MessageDigest.getInstance("SHA-256").digest(artifact.readBytes()).joinToString("") { "%02x".format(it) }
            assertEquals(row["data"]!!.jsonObject.text("contentSha256"),hash)
        }
        return directory to rows
    }
    private fun response(content: String) = MockResponse().setBody(buildJsonObject {
        put("choices",buildJsonArray { add(buildJsonObject { put("finish_reason","stop"); put("message",buildJsonObject { put("role","assistant"); put("content",content) }) }) })
    }.toString())
    @Test fun productionChatWritesRealProviderSchemaToolFeedbackAndTerminalLocally() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setBody("""{"choices":[{"finish_reason":"tool_calls","message":{"role":"assistant","tool_calls":[{"id":"read-1","type":"function","function":{"name":"todo_list","arguments":"{}"}}]}}]}"""))
            server.enqueue(response("已读取当前 Todo 列表。"))
            server.enqueue(response("""{"decision":"complete","reasonType":"fulfilled","reason":"Todo list read","nextStep":"","requirements":[{"text":"Read todos","status":"met","evidenceIds":["read-1"]}]}"""))
            server.start()
            val connection = Connection(name="Trace fixture",endpoint=server.url("/model").toString(),model="fixture-model",stream=false)
            val reply = SharedChatAgent(app,ModelClient(true),true).reply(connection,"local-fixture-secret",listOf(Message(role="user",content="列出当前 Todo")),"Skill marker for trace",buildJsonObject {},{ "" },false,"trace-${newId()}","trace-chat",{ "" },{ error("No phone operation expected") },{})
            assertTrue(reply.text.isNotBlank())
            val (directory, rows) = captured()
            for (type in listOf("run.started","loop.transition","capabilities.snapshot","model.provider.payload","tool.requested","tool.dispatch.started","tool.result","tool.feedback.appended","run.finished")) assertTrue(type,rows.any { it.text("type")==type })
            val payloads = rows.filter { it.text("type")=="model.provider.payload" }.map { row -> MeloJson.parseToJsonElement(File(directory,row["data"]!!.jsonObject.text("contentRef")).readText()).jsonObject }
            val request = server.takeRequest(3,TimeUnit.SECONDS)!!.body.readUtf8()
            assertEquals(MeloJson.parseToJsonElement(request),payloads.first())
            assertTrue(payloads.first().toString().contains("todo_list"))
            assertTrue(payloads.drop(1).any { it.toString().contains("read-1") && it.toString().contains("todos") })
            for (file in File(directory,"artifacts").listFiles().orEmpty()) assertFalse(file.readText().contains("local-fixture-secret"))
        }
    }
    @Test fun childScopesShareASequenceAndDoNotExposeCredentialsOrMedia() = runBlocking {
        LoopTrace.run(app,"parent-${newId()}","chat","fixture",outcome={ _: Unit -> "partial" }) {
            withContext(LoopTrace.ToolScope("child-launch")) {
                val parent = LoopTrace.captureScope()
                LoopTrace.run(app,"child-${newId()}","device","fixture child",parent=parent,outcome={ _: Unit -> "blocked" }) {
                    SharedCoreTurn.open(app,"loop-child","turn",listOf("android_device"),rounds=2).use { turn ->
                        turn.request()
                        LoopTrace.emit("tool.result",buildJsonObject { put("effectState","unknown") },buildJsonObject { put("apiKey","DO_NOT_STORE_THIS"); put("image", "data:image/png;base64,AAABBB") })
                    }
                }
            }
        }
        val (directory,rows) = captured()
        assertEquals(2,rows.count { it.text("type")=="run.finished" })
        val child = rows.first { it.text("scopeId")=="device" }
        assertTrue(child.text("parentRunId").startsWith("parent-")); assertTrue(child.text("parentSpanId").contains("child-launch"))
        for (file in File(directory,"artifacts").listFiles().orEmpty()) { val text=file.readText(); assertFalse(text.contains("DO_NOT_STORE_THIS")); assertFalse(text.contains("AAABBB")) }
    }
}
