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
    private fun final(protocol: String, text: String = "Fixture done"): MockResponse {
        val encoded = MeloJson.encodeToString(text)
        return MockResponse().setBody(when (protocol) {
            "responses" -> """{"status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":$encoded}]}]}"""
            "anthropic" -> """{"stop_reason":"end_turn","content":[{"type":"text","text":$encoded}]}"""
            else -> """{"choices":[{"finish_reason":"stop","message":{"content":$encoded}}]}"""
        })
    }
    private fun review(protocol: String, complete: Boolean = false, evidence: String = "") = final(protocol, buildJsonObject {
        put("decision", if (complete) "complete" else "partial"); put("reasonType", if (complete) "fulfilled" else "unavailable"); put("reason", "Fixture delivery check"); put("nextStep", "")
        put("requirements", buildJsonArray { add(buildJsonObject { put("text", "Requested delivery"); put("status", if (complete) "met" else "missing"); put("evidenceIds", buildJsonArray { if (complete) add(evidence) }) }) })
    }.toString())
    @Test fun shortChineseRetryRetainsPhoneSchemaAndNeverCompletesAnUnexecutedTask() = runBlocking {
        for (protocol in listOf("chat-completions", "responses", "anthropic")) for (execute in listOf(true, false)) MockWebServer().use { model ->
            model.start()
            val original = "打开汽水音乐 搜索浅影阿的《牡丹亭》播放"
            val messages = listOf(Message(role = "user", content = original), Message(role = "assistant", content = "请先启用 Accessibility Service。"), Message(role = "user", content = "重试"))
            if (execute) {
                model.enqueue(tool(protocol, "phone_use", "retry-phone", buildJsonObject { put("goal", original); put("purpose", "action") }))
                model.enqueue(final(protocol, "Fixture phone task completed")); model.enqueue(review(protocol, true, "retry-phone"))
            } else model.enqueue(final(protocol, "我没有可操作手机的工具，请手动完成。"))
            val connection = Connection(endpoint = model.url("/model").toString(), model = "fixture-model", protocol = protocol, stream = false)
            var invoked = 0; val scenes = mutableListOf<JsonObject>()
            val result = SharedChatAgent(app, ModelClient(true), true).reply(connection, "fixture-key", messages, "", buildJsonObject {}, { "" }, true, newId(), "retry-fixture", { "" },
                invokePhone = { args ->
                    invoked++; assertEquals(original, args.text("goal"))
                    DeviceToolResult(buildJsonObject { put("ok", true); put("status", "achieved"); put("goal", original); put("summary", "Local fixture, no real music or playback"); put("run_id", "fixture-phone") })
                }, onPhase = {}, onScene = { scenes.add(it) })
            val first = model.takeRequest(2, TimeUnit.SECONDS)!!.body.readUtf8()
            assertTrue("phone schema must survive short retry in $protocol", first.contains("phone_use"))
            assertTrue(first.contains("todo_list")); assertTrue(first.contains("calendar_list_events"))
            val scene = scenes.last(); val completion = scene.getValue("completion").jsonObject
            assertTrue(completion.getValue("task").jsonObject.text("original").contains(original))
            val catalog = scene.getValue("pipeline").jsonArray.map { it.jsonObject }.single { it.text("id") == "tools" }.text("output")
            assertTrue(catalog.contains("phone_use")); assertTrue(catalog.contains("todo_list"))
            assertEquals(if (execute) 1 else 0, invoked)
            assertEquals(if (execute) "completed" else "blocked", result.outcome)
            if (!execute) assertEquals("MISSING_TOOL_EVIDENCE", result.stopReason)
            assertEquals(if (execute) 3 else 1, model.requestCount)
        }
    }
    @Test fun informalFollowupsKeepTheSameCatalogOnEveryWorkRoundWithoutRoutingRecognition() = runBlocking {
        for (protocol in listOf("chat-completions", "responses", "anthropic")) MockWebServer().use { model ->
            model.start()
            val original = "打开汽水音乐，搜索牡丹亭播放"
            val messages = listOf(Message(role = "user", content = original), Message(role = "assistant", content = "以前没有手机工具。"), Message(role = "user", content = "再次重试，换个办法继续刚才的事"))
            model.enqueue(tool(protocol, "phone_use", "informal-phone", buildJsonObject { put("goal", original); put("purpose", "action") }))
            model.enqueue(final(protocol)); model.enqueue(review(protocol, true, "informal-phone"))
            var calls = 0
            val result = SharedChatAgent(app, ModelClient(true), true).reply(Connection(endpoint = model.url("/model").toString(), model = "fixture", protocol = protocol, stream = false), "fixture-key", messages, "", buildJsonObject {}, { "" }, true, newId(), "informal-fixture", { "" },
                invokePhone = { calls++; DeviceToolResult(buildJsonObject { put("ok", true); put("status", "achieved"); put("summary", "Local fixture result") }) }, onPhase = {})
            assertEquals("completed", result.outcome); assertEquals(1, calls)
            repeat(2) {
                val request = model.takeRequest(2, TimeUnit.SECONDS)!!.body.readUtf8()
                assertTrue(request.contains("phone_use")); assertTrue(request.contains("todo_list")); assertTrue(request.contains(original)); assertTrue(request.contains("再次重试"))
            }
            val checker = model.takeRequest(2, TimeUnit.SECONDS)!!.body.readUtf8()
            assertTrue(checker.contains("task completion checker")); assertEquals(3, model.requestCount)
        }
    }
    @Test fun publicResearchCannotTakeOverPhoneDespiteRegisteredCapability() = runBlocking {
        MockWebServer().use { model ->
            model.start(); model.enqueue(tool("chat-completions", "phone_use", "unrequested-phone", buildJsonObject { put("goal", "Open Maps and research restaurants on screen"); put("purpose", "research") }))
            var calls = 0
            val result = SharedChatAgent(app, ModelClient(true), true).reply(Connection(endpoint = model.url("/model").toString(), model = "fixture", stream = false), "fixture-key", listOf(Message(role = "user", content = "搜索 Surry Hills 当前营业的餐厅")), "", buildJsonObject {}, { "" }, true, newId(), "research-boundary", { "" },
                invokePhone = { calls++; error("Unrequested screen takeover") }, onPhase = {})
            assertEquals(0, calls); assertEquals("blocked", result.outcome); assertEquals("PHONE_NOT_REQUESTED", result.stopReason)
            assertTrue(model.takeRequest(2, TimeUnit.SECONDS)!!.body.readUtf8().contains("phone_use"))
        }
    }
    @Test fun threeProtocolsSearchReadThenNavigateAndPersistOnlyObservedEvents() = runBlocking {
        for (protocol in listOf("chat-completions", "responses", "anthropic")) MockWebServer().use { model -> MockWebServer().use { backend ->
            model.start(); backend.start()
            val url = backend.url("/menu").toString()
            backend.enqueue(MockResponse().setHeader("Content-Type", "application/json").setBody("""{"results":[{"title":"Fixture A","url":"$url","snippet":"Menu needs reading"}]}"""))
            backend.enqueue(MockResponse().setHeader("Content-Type", "text/html").setBody("<h1>Fixture A</h1><p>Public menu observed</p>"))
            model.enqueue(tool(protocol, "web_search", "s", buildJsonObject { put("query", "Surry Hills brunch") }))
            model.enqueue(tool(protocol, "fetch_url", "f", buildJsonObject { put("url", url) }))
            model.enqueue(tool(protocol, "phone_use", "p", buildJsonObject { put("goal", "Open the Fixture A navigation page, stop before starting a trip"); put("purpose", "action") }))
            model.enqueue(final(protocol)); model.enqueue(review(protocol))
            val config = buildJsonObject { put("search", buildJsonObject { put("backend", "http"); put("endpoint", backend.url("/search").toString()) }) }
            val connection = Connection(endpoint = model.url("/model").toString(), model = "fixture-model", protocol = protocol, stream = false)
            val scenes = mutableListOf<JsonObject>(); var phoneCalls = 0
            val answer = SharedChatAgent(app, ModelClient(true), true).reply(connection, "fixture-only-key", listOf(Message(role = "user", content = "推荐 Surry Hills brunch 然后导航到那里")), "", config, { "" }, true, "research-r", "research-c", { "" },
                invokePhone = { assertEquals(2, backend.requestCount); phoneCalls++; DeviceToolResult(buildJsonObject { put("ok", true); put("status", "achieved"); put("run_id", "fixture-phone"); put("summary", "Fixture navigation page observed; no real Maps or trip") }) }, onPhase = {}, onScene = { scenes.add(it) })
            assertEquals("partial", answer.outcome); assertEquals("GOAL_UNAVAILABLE", answer.stopReason); assertEquals(1, phoneCalls)
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
                val events = runtime.value("sessionEvents", buildJsonObject { put("scene", restored) }).jsonArray
                assertEquals(events, restored.getValue("sessionEvents"))
                assertTrue(events.any { it.jsonObject.text("kind") == "terminal" })
                events.forEach { assertTrue(context.contains(it.jsonObject.text("eventId"))) }
                assertEquals(1, phoneCalls)
                assertEquals(5, model.requestCount); assertEquals(2, backend.requestCount)
            }
            assertEquals(5, model.requestCount); assertEquals(2, backend.requestCount)
            repeat(5) { index ->
                val request = model.takeRequest(2, TimeUnit.SECONDS)!!.body.readUtf8()
                assertFalse(request.contains("fixture-only-key"))
                if (index == 4) { assertTrue(request.contains("task completion checker")); assertFalse(request.contains("\"name\":\"phone_use\"")) }
            }
            model.enqueue(final(protocol))
            val follow = SharedChatAgent(app, ModelClient(true), true).reply(connection, "fixture-only-key",
                listOf(Message(role = "user", content = "Write one short greeting.")), "", config, { "" }, true,
                "follow-r", "research-c", { "" }, invokePhone = { error("History must not replay a phone action") },
                onPhase = {}, previousScenes = listOf(restored))
            assertEquals("completed", follow.outcome)
            val followRequest = model.takeRequest(2, TimeUnit.SECONDS)!!.body.readUtf8()
            assertTrue(followRequest.contains("research-r/tool/p/result"))
            assertEquals(1, phoneCalls); assertEquals(6, model.requestCount); assertEquals(2, backend.requestCount)
        } }
    }

    @Test fun missingRequiredNavigationIsPartialAndAnUnobservedUrlCannotBeRead() = runBlocking {
        MockWebServer().use { model -> MockWebServer().use { backend ->
            model.start(); backend.start()
            model.enqueue(tool("chat-completions", "web_search", "s", buildJsonObject { put("query", "brunch") }))
            model.enqueue(tool("chat-completions", "fetch_url", "bad", buildJsonObject { put("url", backend.url("/not-returned").toString()) }))
            model.enqueue(final("chat-completions")); model.enqueue(review("chat-completions"))
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
            model.enqueue(tool(protocol,"web_search","unavailable",buildJsonObject {put("query","brunch")})); model.enqueue(final(protocol,"Search unavailable; no destination has been verified.")); model.enqueue(review(protocol))
            val blocked=agent.reply(connection,"fixture-model-key",listOf(goal),"",config(false),{"fixture-brave-key"},true,"retry-before-r","retry-c",{""},{error("No phone task")},{})
            assertEquals("blocked",blocked.outcome);assertEquals("GOAL_UNAVAILABLE",blocked.stopReason)
            assertEquals(3,model.requestCount);assertEquals(0,backend.requestCount)
            repeat(3) { index -> val body=model.takeRequest(2,TimeUnit.SECONDS)!!.body.readUtf8(); if(index == 0) { assertTrue(body.contains("todo_list")); assertFalse(body.contains("\"name\":\"web_search\"")) } }
            backend.enqueue(MockResponse().setHeader("Content-Type","application/json").setBody("""{"web":{"results":[{"title":"Fixture brunch","url":"https://fixture.invalid/menu","description":"Fixture public menu"}]}}"""))
            model.enqueue(tool(protocol,"web_search","retry-search",buildJsonObject {put("query","Surry Hills brunch")}));model.enqueue(final(protocol));model.enqueue(review(protocol))
            val messages=listOf(goal,Message(role="assistant",content="I have no search or phone tools."),Message(role="user",content="再试一次，只做检索并列出来源，先不要导航。"))
            val scenes=mutableListOf<JsonObject>()
            val result=agent.reply(connection,"fixture-model-key",messages,"",config(true),{"fixture-brave-key"},true,"retry-after-r","retry-c",{""},{error("Retry denied navigation")},{},onScene={scenes.add(it)})
            assertEquals("partial",result.outcome);assertEquals("GOAL_UNAVAILABLE",result.stopReason);assertEquals(6,model.requestCount);assertEquals(1,backend.requestCount)
            val search=backend.takeRequest(2,TimeUnit.SECONDS)!!
            assertEquals("GET",search.method);assertEquals("fixture-brave-key",search.getHeader("X-Subscription-Token"));assertNull(search.getHeader("Authorization"))
            assertTrue(search.path!!.contains("q=Surry%20Hills%20brunch"))
            val first=model.takeRequest(2,TimeUnit.SECONDS)!!.body.readUtf8()
            assertTrue(first.contains("web_search"));assertFalse(first.contains("\"name\":\"phone_use\""))
            val scene=scenes.last();assertEquals(listOf("web_search"),scene.getValue("operations").jsonArray.map{it.jsonObject.text("name")})
            assertEquals(1,scene.getValue("sources").jsonArray.size);assertFalse(scene.toString().contains("fixture-brave-key"))
        } }
    }

    @Test fun goalReviewDistinguishesExactObservedActionsFromUnverifiedSubtasks() = runBlocking {
        for (protocol in listOf("chat-completions", "responses", "anthropic")) for (proof in listOf("exact", "subtask", "unverified")) MockWebServer().use { model ->
            model.start()
            val goal = "在手机上打开设置应用"
            model.enqueue(tool(protocol, "phone_use", "action", buildJsonObject { put("goal", goal); put("purpose", "action") }))
            model.enqueue(final(protocol)); model.enqueue(review(protocol, proof == "exact", "action"))
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
            assertEquals(1, effects); assertEquals(3, model.requestCount)
            assertEquals(if (proof == "exact") "completed" else "partial", result.outcome)
            val receipt = scenes.last().getValue("completion").jsonObject
            assertEquals(if (proof == "exact") "supported" else "unverified", receipt.text("goalState"))
            if (proof == "exact") assertTrue(receipt.getValue("evidenceIds").jsonArray.contains(JsonPrimitive("action")))
            else assertEquals("GOAL_UNAVAILABLE", receipt.text("reason"))
        }
    }

}
