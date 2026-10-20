package com.melo.android

import android.os.Build
import androidx.test.core.app.ApplicationProvider
import com.melo.android.chat.SharedChatAgent
import com.melo.android.core.*
import com.melo.android.data.*
import com.melo.android.device.DeviceToolResult
import com.melo.android.network.ModelClient
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import okhttp3.mockwebserver.*
import org.junit.*
import org.junit.Assert.*
import java.util.concurrent.TimeUnit

/** Actual installed Core + three wire protocols + HTTP. Phone effects remain an explicit local Fixture. */
class ResearchExecutionFlowTest {
    private val app get() = ApplicationProvider.getApplicationContext<MeloApplication>()
    @Before fun emulatorOnly() { Assume.assumeTrue(Build.FINGERPRINT.contains("generic") || Build.MODEL.contains("sdk_gphone")) }
    private fun tool(protocol: String, name: String, id: String, args: JsonObject): MockResponse {
        val encoded = JsonPrimitive(args.toString()).toString()
        val payload = when (protocol) {
            "responses" -> """{"status":"completed","output":[{"type":"reasoning","encrypted_content":"opaque-never-display","summary":[{"type":"summary_text","text":"Public fixture summary"}]},{"type":"function_call","call_id":"$id","name":"$name","arguments":$encoded}]}"""
            "anthropic" -> """{"stop_reason":"tool_use","content":[{"type":"tool_use","id":"$id","name":"$name","input":$args}]}"""
            else -> """{"choices":[{"finish_reason":"tool_calls","message":{"role":"assistant","tool_calls":[{"id":"$id","type":"function","function":{"name":"$name","arguments":$encoded}}]}}]}"""
        }
        return MockResponse().setBody(payload)
    }
    private fun final(protocol: String) = MockResponse().setBody(when (protocol) {
        "responses" -> """{"status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"Fixture done"}]}]}"""
        "anthropic" -> """{"stop_reason":"end_turn","content":[{"type":"text","text":"Fixture done"}]}"""
        else -> """{"choices":[{"finish_reason":"stop","message":{"content":"Fixture done"}}]}"""
    })
    @Test fun threeProtocolsSearchReadThenNavigateAndPersistOnlyObservedEvents() = runBlocking {
        for (protocol in listOf("chat-completions", "responses", "anthropic")) MockWebServer().use { model -> MockWebServer().use { backend ->
            model.start(); backend.start()
            val url = backend.url("/menu").toString()
            backend.enqueue(MockResponse().setHeader("Content-Type", "application/json").setBody("""{"results":[{"title":"Fixture A","url":"$url","snippet":"Menu needs reading"}]}"""))
            backend.enqueue(MockResponse().setHeader("Content-Type", "text/html").setBody("<h1>Fixture A</h1><p>Public menu observed</p>"))
            model.enqueue(tool(protocol, "web_search", "s", buildJsonObject { put("query", "Surry Hills brunch") }))
            model.enqueue(tool(protocol, "fetch_url", "f", buildJsonObject { put("url", url) }))
            model.enqueue(tool(protocol, "phone_use", "p", buildJsonObject { put("goal", "Open the Fixture A navigation page, stop before starting a trip"); put("purpose", "action") }))
            model.enqueue(final(protocol))
            val config = buildJsonObject { put("search", buildJsonObject { put("backend", "http"); put("endpoint", backend.url("/search").toString()) }) }
            val connection = Connection(endpoint = model.url("/model").toString(), model = "fixture-model", protocol = protocol, stream = false)
            val scenes = mutableListOf<JsonObject>(); var phoneCalls = 0
            val answer = SharedChatAgent(app, ModelClient(true), true).reply(connection, "fixture-only-key", listOf(Message(role = "user", content = "推荐 Surry Hills brunch 然后导航到那里")), "", config, { "" }, true, "research-r", "research-c", { "" },
                invokePhone = { assertEquals(2, backend.requestCount); phoneCalls++; DeviceToolResult(buildJsonObject { put("ok", true); put("status", "achieved"); put("run_id", "fixture-phone"); put("summary", "Fixture navigation page observed; no real Maps or trip") }) }, onPhase = {}, onScene = { scenes.add(it) })
            assertEquals("partial", answer.outcome); assertEquals("RELEVANT_READ_SOURCE_MISSING", answer.stopReason); assertEquals(1, phoneCalls)
            val scene = scenes.last(); assertEquals("failed", scene.text("status")); assertEquals("partial", scene.text("taskOutcome"))
            assertTrue(scene.getValue("operations").jsonArray.all { it.jsonObject.text("status") == "completed" })
            assertEquals("unverified", scene.getValue("completion").jsonObject.text("goalState"))
            assertEquals(listOf("web_search", "fetch_url", "phone_use"), scene.getValue("operations").jsonArray.map { it.jsonObject.text("name") })
            assertTrue(scene.getValue("sources").jsonArray.single().jsonObject.getValue("accessed").jsonPrimitive.boolean)
            assertTrue(scenes.any { it.getValue("operations").jsonArray.any { row -> row.jsonObject.text("status") == "running" } })
            assertFalse(scene.toString().contains("fixture-only-key")); assertFalse(scene.toString().contains("opaque-never-display"))
            if (protocol == "responses") assertTrue(scene.toString().contains("Public fixture summary"))
            val restored = MeloJson.parseToJsonElement(MeloJson.encodeToString(scene)).jsonObject
            SharedCoreRuntime.open(app).use { runtime ->
                val context = runtime.value("executionContext", buildJsonObject { put("scenes", buildJsonArray { add(restored) }) }).jsonPrimitive.content
                assertTrue(context.contains("web_search")); assertTrue(context.contains("fetch_url")); assertTrue(context.contains("phone_use"))
            }
            assertEquals(4, model.requestCount); assertEquals(2, backend.requestCount)
            repeat(4) { assertFalse(model.takeRequest(2, TimeUnit.SECONDS)!!.body.readUtf8().contains("fixture-only-key")) }
        } }
    }

    @Test fun missingRequiredNavigationIsPartialAndAnUnobservedUrlCannotBeRead() = runBlocking {
        MockWebServer().use { model -> MockWebServer().use { backend ->
            model.start(); backend.start()
            model.enqueue(tool("chat-completions", "web_search", "s", buildJsonObject { put("query", "brunch") }))
            model.enqueue(tool("chat-completions", "fetch_url", "bad", buildJsonObject { put("url", backend.url("/not-returned").toString()) }))
            model.enqueue(final("chat-completions"))
            backend.enqueue(MockResponse().setHeader("Content-Type", "application/json").setBody("""{"results":[{"url":"https://fixture.invalid/menu"}]}"""))
            val config = buildJsonObject { put("search", buildJsonObject { put("backend", "http"); put("endpoint", backend.url("/search").toString()) }) }
            val scenes=mutableListOf<JsonObject>(); var phones=0
            val result=SharedChatAgent(app, ModelClient(true), true).reply(Connection(endpoint=model.url("/model").toString(), model="fixture", stream=false), "fixture-key", listOf(Message(role="user",content="推荐 brunch 然后导航")), "", config, { "" }, true, "partial-r", "partial-c", { "" }, { phones++; error("Phone must not run") }, {}, onScene={ scenes.add(it) })
            assertEquals("partial", result.outcome); assertEquals("MISSING_TOOL_EVIDENCE", result.stopReason)
            assertEquals(0, phones); assertEquals(1, backend.requestCount)
            assertTrue(scenes.last().toString().contains("FETCH_URL_NOT_IN_EVIDENCE")); assertEquals("partial", scenes.last().text("taskOutcome"))
        } }
    }

    @Test fun emptySearchDoesNotAuthorizeAnInventedNavigationDestination() = runBlocking {
        MockWebServer().use { model -> MockWebServer().use { backend ->
            model.start(); backend.start()
            model.enqueue(tool("chat-completions", "web_search", "empty", buildJsonObject { put("query", "brunch") }))
            model.enqueue(tool("chat-completions", "phone_use", "nav", buildJsonObject { put("goal", "Navigate to an invented place"); put("purpose", "action") }))
            backend.enqueue(MockResponse().setHeader("Content-Type", "application/json").setBody("""{"results":[]}"""))
            val config=buildJsonObject { put("search",buildJsonObject { put("backend","http");put("endpoint",backend.url("/search").toString()) }) }
            var effects=0
            val result=SharedChatAgent(app,ModelClient(true),true).reply(Connection(endpoint=model.url("/model").toString(),model="fixture",stream=false),"fixture-key",listOf(Message(role="user",content="推荐 brunch 然后导航")),"",config,{ "" },true,"empty-r","empty-c",{ "" },{ effects++;error("No observed destination") },{})
            assertEquals(0,effects);assertEquals("DESTINATION_UNVERIFIED",result.stopReason);assertEquals("partial",result.outcome)
            assertEquals(2,model.requestCount);assertEquals(1,backend.requestCount)
        } }
    }
    @Test fun retryReevaluatesCurrentBraveConfigWithAllThreeProtocols() = runBlocking {
        for (protocol in listOf("chat-completions", "responses", "anthropic")) MockWebServer().use { model -> MockWebServer().use { backend ->
            model.start(); backend.start()
            val connection = Connection(endpoint=model.url("/model").toString(),model="fixture-model",protocol=protocol,stream=false)
            val goal=Message(role="user",content="推荐 Surry Hills brunch，然后用 Google Maps 导航。")
            fun config(enabled: Boolean)=buildJsonObject { put("search",buildJsonObject {
                put("backend",if(enabled) "http" else "none");put("provider","brave");put("endpoint",backend.url("/search").toString());put("credentialRef","search")
            }) }
            val agent=SharedChatAgent(app,ModelClient(true),true)
            val blocked=agent.reply(connection,"fixture-model-key",listOf(goal),"",config(false),{"fixture-brave-key"},true,"retry-before-r","retry-c",{""},{error("No phone task")},{})
            assertEquals("blocked",blocked.outcome);assertEquals("SEARCH_UNAVAILABLE",blocked.stopReason)
            assertEquals(0,model.requestCount);assertEquals(0,backend.requestCount)
            backend.enqueue(MockResponse().setHeader("Content-Type","application/json").setBody("""{"web":{"results":[{"title":"Fixture brunch","url":"https://fixture.invalid/menu","description":"Fixture public menu"}]}}"""))
            model.enqueue(tool(protocol,"web_search","retry-search",buildJsonObject {put("query","Surry Hills brunch")}));model.enqueue(final(protocol))
            val messages=listOf(goal,Message(role="assistant",content="I have no search or phone tools."),Message(role="user",content="再试一次，只做检索并列出来源，先不要导航。"))
            val scenes=mutableListOf<JsonObject>()
            val result=agent.reply(connection,"fixture-model-key",messages,"",config(true),{"fixture-brave-key"},true,"retry-after-r","retry-c",{""},{error("Retry denied navigation")},{},onScene={scenes.add(it)})
            assertEquals("partial",result.outcome);assertEquals("RELEVANT_READ_SOURCE_MISSING",result.stopReason);assertEquals(2,model.requestCount);assertEquals(1,backend.requestCount)
            val search=backend.takeRequest(2,TimeUnit.SECONDS)!!
            assertEquals("GET",search.method);assertEquals("fixture-brave-key",search.getHeader("X-Subscription-Token"));assertNull(search.getHeader("Authorization"))
            assertTrue(search.path!!.contains("q=Surry%20Hills%20brunch"))
            val first=model.takeRequest(2,TimeUnit.SECONDS)!!.body.readUtf8()
            assertTrue(first.contains("web_search"));assertFalse(first.contains("\"name\":\"phone_use\""))
            val scene=scenes.last();assertEquals(listOf("web_search"),scene.getValue("operations").jsonArray.map{it.jsonObject.text("name")})
            assertEquals(1,scene.getValue("sources").jsonArray.size);assertFalse(scene.toString().contains("fixture-brave-key"))
        } }
    }

    @Test fun onlyHostVerifiedReceiptForTheExactGoalCompletesAnAction() = runBlocking {
        for (protocol in listOf("chat-completions", "responses", "anthropic")) for (proof in listOf("exact", "subtask", "unverified")) MockWebServer().use { model ->
            model.start()
            val goal = "在手机上打开设置应用"
            model.enqueue(tool(protocol, "phone_use", "action", buildJsonObject { put("goal", goal); put("purpose", "action") }))
            model.enqueue(final(protocol))
            val scenes = mutableListOf<JsonObject>(); var effects = 0
            val result = SharedChatAgent(app, ModelClient(true), true).reply(
                Connection(endpoint = model.url("/model").toString(), model = "fixture", protocol = protocol, stream = false),
                "fixture-key", listOf(Message(role = "user", content = goal)), "", buildJsonObject {}, { "" }, true,
                "proof-$proof", "proof-chat", { "" }, invokePhone = {
                    effects++
                    DeviceToolResult(buildJsonObject {
                        put("ok", true); put("status", "achieved"); put("run_id", "visible-fixture")
                        put("goal", if (proof == "subtask") "打开桌面" else goal)
                        if (proof != "unverified") put("verification", "visible_facts")
                    })
                }, onPhase = {}, onScene = { scenes.add(it) })
            assertEquals(1, effects); assertEquals(2, model.requestCount)
            assertEquals(if (proof == "exact") "completed" else "partial", result.outcome)
            val receipt = scenes.last().getValue("completion").jsonObject
            assertEquals(if (proof == "exact") "verified" else "unverified", receipt.text("goalState"))
            if (proof == "exact") assertTrue(receipt.getValue("evidenceIds").jsonArray.contains(JsonPrimitive("visible-fixture")))
            else assertEquals("GOAL_TERMINAL_EVIDENCE_MISSING", receipt.text("reason"))
        }
    }

}
