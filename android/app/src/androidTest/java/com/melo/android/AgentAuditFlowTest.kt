package com.melo.android

import android.os.Build
import androidx.test.core.app.ApplicationProvider
import com.melo.android.data.*
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.first
import kotlinx.serialization.json.*
import okhttp3.mockwebserver.*
import org.junit.*
import org.junit.Assert.*

/**
 * 2026-11-10 follow-up to the Agent audit, through the real chat loop, the packaged Core and HTTP
 * fixtures. Each test names what the user saw before.
 */
class AgentAuditFlowTest {
    private val app get() = ApplicationProvider.getApplicationContext<MeloApplication>()
    private var before: AppData? = null
    @Before fun setup() = runBlocking {
        Assume.assumeTrue("Chat fixtures only run on Emulator", Build.FINGERPRINT.contains("generic") || Build.MODEL.contains("sdk_gphone"))
        withTimeout(15_000) { app.engine.runtime.first { it.initialized } }
        before = app.repository.data.value
        withContext(Dispatchers.Main) { app.engine.dismissError() }
    }
    @After fun restore() = runBlocking {
        if (before == null) return@runBlocking
        withContext(Dispatchers.Main) { app.engine.cancel() }
        withTimeout(15_000) { while (app.engine.runtime.value.turns.isNotEmpty()) delay(30) }
        before?.let { snapshot -> app.repository.change { snapshot } }
        Unit
    }
    private suspend fun chat(server: MockWebServer): String {
        val connection = Connection(name = "agent-audit-fixture", endpoint = server.url("/model").toString(), model = "fixture-model", protocol = "chat-completions", stream = false)
        app.repository.saveConnection(connection, "fixture-model-key")
        app.repository.change { it.copy(settings = it.settings.copy(agentRuntime = buildJsonObject {})) }
        return app.repository.newChat().also { id -> app.repository.editChat(id) { it.copy(connectionId = connection.id) } }
    }
    private suspend fun send(id: String, text: String): RunRecord {
        withContext(Dispatchers.Main) { assertTrue(app.engine.send(id, text)) }
        withTimeout(40_000) { while (app.engine.runtime.value.turns.containsKey(id)) delay(30) }
        return app.repository.data.value.runs.last { it.chatId == id }
    }
    private fun say(text: String, inputTokens: Long? = null) = MockResponse().setBody(buildJsonObject {
        put("model", "fixture-model"); inputTokens?.let { put("usage", buildJsonObject { put("prompt_tokens", it) }) }
        put("choices", buildJsonArray { add(buildJsonObject { put("finish_reason", "stop"); put("message", buildJsonObject { put("role", "assistant"); put("content", text) }) }) })
    }.toString())
    private fun call(name: String, id: String, args: JsonObject) = MockResponse().setBody(buildJsonObject { put("choices", buildJsonArray { add(buildJsonObject { put("finish_reason", "tool_calls"); put("message", buildJsonObject { put("role", "assistant"); put("tool_calls", buildJsonArray {
        add(buildJsonObject { put("id", id); put("type", "function"); put("function", buildJsonObject { put("name", name); put("arguments", args.toString()) }) })
    }) }) }) }) }.toString())
    private val selfContained = """{"decision":"complete","evaluationValid":true,"needsEvaluation":false,"turnKind":"answer","reasonType":"self_contained","reason":"Answered.","requirements":[{"text":"explanation","kind":"response","status":"met","evidenceIds":[]}]}"""
    private val sentBack = """{"decision":"continue","evaluationValid":true,"needsEvaluation":false,"reasonType":"lookup_missing","reason":"The explanation is wrong.","nextStep":"Explain it correctly.","requirements":[{"text":"explanation","kind":"external_fact","status":"missing","evidenceIds":[]}]}"""
    /** Requests by what they ask for: the completion check, the limit write-up, a member, or the lead. */
    private inner class Roles(private val answer: (role: String, round: Int, body: String) -> MockResponse) : Dispatcher() {
        val seen = java.util.concurrent.CopyOnWriteArrayList<Pair<String, String>>()
        fun role(body: String) = when {
            body.contains("task completion checker") -> "check"
            body.contains("The execution allowance is ending") -> "delivery"
            body.contains("internal research specialist") -> "member"
            else -> "lead"
        }
        fun roles() = seen.map { it.first }
        fun of(role: String) = seen.filter { it.first == role }.map { it.second }
        override fun dispatch(request: RecordedRequest): MockResponse {
            val body = request.body.readUtf8(); val role = role(body)
            val round = synchronized(seen) { seen += role to body; seen.count { it.first == role } }
            return answer(role, round, body)
        }
    }
    private fun completion(run: RunRecord) = run.sharedScene!!.getValue("completion").jsonObject
    private fun stages(run: RunRecord) = run.sharedScene!!.getValue("pipeline").jsonArray.map { it.jsonObject }
    // A provider usage that leaves nothing for further work, only the delivery reserve.
    private val spent = 380_000L

    // D1. The allowance ended after the answer had been written and before its check. The answer was thrown
    // away and the model was asked to write "confirmed / missing / next steps" from tool results it never had.
    @Test fun anAnswerWrittenWhenTheAllowanceEndsIsDeliveredNotRewritten() = runBlocking {
        MockWebServer().use { model ->
            val answer = "天空呈蓝色，是因为空气分子对阳光中波长较短的蓝光散射得比红光强得多。"
            val roles = Roles { role, _, _ -> when (role) { "check" -> say(selfContained); "delivery" -> say("已确认：无。\n\n缺失：全部。\n\n下一步：请重新提问。"); else -> say(answer, spent) } }
            model.dispatcher = roles; model.start()
            val id = chat(model)
            val run = send(id, "用一句话解释天空为什么是蓝色的。")
            assertEquals("no request asked the model to write the answer again", listOf("lead", "check"), roles.roles())
            assertEquals(answer, run.partial)
            assertEquals(answer, app.repository.data.value.chats.first { it.id == id }.messages.last { it.role == "assistant" }.content)
            assertEquals(run.error, "completed", run.status)
            assertEquals("LIMIT_DELIVERED", completion(run).text("reason"))
        }
    }

    // D1. The same when the check cannot run either: the answer stands as written and says that it is unchecked.
    @Test fun whenItsCheckCannotRunTheWrittenAnswerIsDeliveredAndMarkedUnverified() = runBlocking {
        MockWebServer().use { model ->
            val answer = "天空呈蓝色，是因为空气分子对阳光中波长较短的蓝光散射得比红光强得多。"
            val roles = Roles { role, _, _ -> when (role) { "check" -> MockResponse().setResponseCode(500); "delivery" -> say("重写的三段式。"); else -> say(answer, spent) } }
            model.dispatcher = roles; model.start()
            val id = chat(model)
            val run = send(id, "用一句话解释天空为什么是蓝色的。")
            assertEquals(listOf("lead", "check"), roles.roles())
            assertTrue("the answer is kept word for word: " + run.partial, run.partial.startsWith(answer))
            assertTrue("and says that it was not checked", run.partial.contains("交付检查未能完成"))
            assertEquals(run.error, "unverified", run.status); assertEquals("unverified", completion(run).text("outcome"))
        }
    }

    // D1. An answer the check sent back is not a pending answer: the write-up is made from the evidence, and
    // when that fails too the rejected draft is not handed over as if it stood.
    @Test fun anAnswerTheCheckSentBackIsNotHandedOverWhenTheAllowanceThenEnds() = runBlocking {
        MockWebServer().use { model ->
            val roles = Roles { role, _, _ -> when (role) { "check" -> say(sentBack, spent); "delivery" -> MockResponse().setResponseCode(500); else -> say("REJECTED-DRAFT：天空是绿色的。") } }
            model.dispatcher = roles; model.start()
            val id = chat(model)
            val run = send(id, "用一句话解释天空为什么是蓝色的。")
            assertEquals("without a pending answer the write-up is asked for", listOf("lead", "check", "delivery"), roles.roles())
            assertFalse("the answer the check rejected is not delivered: " + run.partial, run.partial.contains("REJECTED-DRAFT"))
            assertNotEquals("completed", run.status)
        }
    }

    // D1 on a member's turn. A member's answer is not checked on this host: it goes to the lead as written,
    // also when the allowance ends with that very reply. Only the lead, which has written nothing yet, is
    // asked for a write-up.
    @Test fun aMembersWrittenAnswerIsHandedOverAsWrittenWhenTheAllowanceEnds() = runBlocking {
        MockWebServer().use { model ->
            val report = "MEMBER-ANSWER: the sky is blue because air scatters blue light most."
            val roles = Roles { role, round, _ -> when (role) {
                "check" -> say(selfContained)
                "delivery" -> say("已确认：天空呈蓝色是因为空气对蓝光的散射最强。\n\n缺失：无。\n\n下一步：无。")
                "member" -> say(report, spent)
                else -> if (round == 1) call("route_task", "route-1", buildJsonObject { put("role", "research"); put("task", "Explain why the sky is blue") }) else say("never reached")
            } }
            model.dispatcher = roles; model.start()
            val run = send(chat(model), "用一句话解释天空为什么是蓝色的。")
            assertEquals("the member is asked once and never for a write-up of its own", listOf("lead", "member", "delivery", "check"), roles.roles())
            val member = stages(run).first { it.text("id") == "internal:1" }
            assertEquals(report, member.text("output")); assertEquals("completed", member.text("status"))
            assertFalse("the lead's write-up is about the user's goal, not a rewrite of the member's report", roles.of("delivery").single().contains("internal research specialist"))
            assertTrue(run.partial.contains("散射"))
        }
    }

    // A check that was asked for and did not come back left no row: an answer marked 受阻 and nothing that said why.
    @Test fun aCheckThatCouldNotRunLeavesARowThatSaysSo() = runBlocking {
        MockWebServer().use { model ->
            val roles = Roles { role, _, _ -> if (role == "check") MockResponse().setResponseCode(500) else say("天空呈蓝色，是因为空气对蓝光的散射更强。") }
            model.dispatcher = roles; model.start()
            val run = send(chat(model), "用一句话解释天空为什么是蓝色的。")
            assertEquals(listOf("lead", "check"), roles.roles())
            assertTrue(run.partial.contains("散射"))
            val check = stages(run).single { it.text("id").startsWith("goal-check:") }
            assertEquals("failed", check.text("status")); assertTrue(check.text("output"), check.text("output").contains("核对请求没有完成") && check.text("output").contains("MODEL_HTTP_500"))
        }
    }

    // A member that answered without a successful tool call was shown as 已中断, although nothing had cut it off.
    @Test fun aMemberThatFinishedItsReportIsNotShownAsInterrupted() = runBlocking {
        MockWebServer().use { model ->
            val roles = Roles { role, round, _ -> when (role) {
                "check" -> say(selfContained)
                "member" -> say("No tool was needed: the sky is blue because of Rayleigh scattering.")
                else -> if (round == 1) call("route_task", "route-1", buildJsonObject { put("role", "research"); put("task", "Explain why the sky is blue") }) else say("天空呈蓝色，是因为瑞利散射。")
            } }
            model.dispatcher = roles; model.start()
            val run = send(chat(model), "用一句话解释天空为什么是蓝色的。")
            val member = stages(run).first { it.text("id") == "internal:1" }
            assertEquals("the member finished; nothing interrupted it", "completed", member.text("status"))
            assertTrue("the lead still reads that the report is unverified", roles.of("lead").last().contains("unverified"))
        }
    }

    private fun calls(items: List<Pair<String, JsonObject>>, prefix: String) = MockResponse().setBody(buildJsonObject { put("choices", buildJsonArray { add(buildJsonObject { put("finish_reason", "tool_calls"); put("message", buildJsonObject { put("role", "assistant"); put("tool_calls", buildJsonArray {
        items.forEachIndexed { index, (name, args) -> add(buildJsonObject { put("id", "$prefix-$index"); put("type", "function"); put("function", buildJsonObject { put("name", name); put("arguments", args.toString()) }) }) }
    }) }) }) }) }.toString())
    private fun pages(missing: String) = object : Dispatcher() {
        override fun dispatch(request: RecordedRequest): MockResponse =
            if (request.path == missing) MockResponse().setResponseCode(404) else MockResponse().setHeader("Content-Type", "text/plain").setBody("Fixture page ${request.path}: nineteen degrees and partly cloudy.")
    }

    // A member cut off at its limit whose write-up also failed showed the host's English note to the lead
    // ("Member round budget reached.") as its row in the task space.
    @Test fun aMemberCutOffAtItsLimitSaysSoInTheTaskSpace() = runBlocking {
        MockWebServer().use { model -> MockWebServer().use { backend ->
            backend.dispatcher = pages("/none"); backend.start()
            val urls = (1..6).map { backend.url("/p$it").toString() }
            val roles = Roles { role, round, _ -> when (role) {
                "check" -> say(selfContained)
                "delivery" -> MockResponse().setResponseCode(500)
                "member" -> calls(listOf("fetch_url" to buildJsonObject { put("url", urls[minOf(round, 6) - 1]) }), "m$round")
                else -> if (round == 1) call("route_task", "route-1", buildJsonObject { put("role", "research"); put("task", "Read the six pages") }) else say("六个页面都写着十九度、多云。")
            } }
            model.dispatcher = roles; model.start()
            val run = send(chat(model), "读一下这六个页面：" + urls.joinToString(" "))
            assertEquals("six rounds, each one page", 6, backend.requestCount); assertEquals(6, roles.of("member").size)
            val member = stages(run).first { it.text("id") == "internal:1" }
            assertEquals("its allowance cut it off", "interrupted", member.text("status"))
            assertTrue(member.text("output"), member.text("output").contains("成员用完了这次的轮数或额度"))
            assertFalse("the note for the lead is not what the user reads", member.text("output").contains("Member round budget reached"))
            assertTrue("the lead still gets that note", roles.of("lead").last().contains("Member round budget reached."))
        } }
    }

    // A call the Core refuses because it keeps failing the same way was answered "本步未执行：REPEATED_FAILURE；
    // 请先完成前置检索" — an instruction to go and search, for a page that does not exist.
    @Test fun aCallRefusedForFailingRepeatedlyIsToldSoNotToSearchFirst() = runBlocking {
        MockWebServer().use { model -> MockWebServer().use { backend ->
            backend.dispatcher = pages("/gone"); backend.start()
            val gone = backend.url("/gone").toString(); val one = backend.url("/one").toString(); val two = backend.url("/two").toString()
            fun fetch(url: String) = "fetch_url" to buildJsonObject { put("url", url) }
            val roles = Roles { role, round, _ -> when (role) {
                "check" -> say(selfContained)
                "member" -> when (round) { 1 -> calls(listOf(fetch(gone)), "a"); 2 -> calls(listOf(fetch(gone), fetch(one)), "b"); 3 -> calls(listOf(fetch(gone), fetch(two)), "c"); else -> say("Two pages read; the third does not exist.") }
                else -> if (round == 1) call("route_task", "route-1", buildJsonObject { put("role", "research"); put("task", "Read the three pages") }) else say("两个页面读到了，第三个不存在。")
            } }
            model.dispatcher = roles; model.start()
            send(chat(model), "读一下这三个页面：$gone $one $two")
            assertEquals("the page that failed twice is not requested a third time", 2, (0 until backend.requestCount).count { backend.takeRequest().path == "/gone" })
            val told = roles.of("member")[3]
            assertTrue("the refusal carries the Core's own account", told.contains("REPEATED_FAILURE") && told.contains("already failed 2 times"))
            assertFalse("and no instruction to search first", told.contains("前置检索"))
        } }
    }

    // A server that sends no call ids, or starts again at the same id in every response, could not finish a
    // reply with two tool rounds: a call without an id was an invalid response, a repeated one stopped the
    // turn with DUPLICATE_CALL_ID.
    @Test fun aServerThatSendsNoCallIdsOrRepeatsThemStillGetsItsReply() = runBlocking {
        MockWebServer().use { model -> MockWebServer().use { backend ->
            backend.dispatcher = pages("/none"); backend.start()
            val one = backend.url("/one").toString(); val two = backend.url("/two").toString()
            fun unnamed(name: String, args: JsonObject) = MockResponse().setBody(buildJsonObject { put("choices", buildJsonArray { add(buildJsonObject { put("finish_reason", "tool_calls"); put("message", buildJsonObject { put("role", "assistant"); put("tool_calls", buildJsonArray {
                add(buildJsonObject { put("type", "function"); put("function", buildJsonObject { put("name", name); put("arguments", args.toString()) }) })
            }) }) }) }) }.toString())
            val roles = Roles { role, round, _ -> when (role) {
                "check" -> say(selfContained)
                // The member's server names every call "call_0".
                "member" -> when (round) { 1 -> call("fetch_url", "call_0", buildJsonObject { put("url", one) }); 2 -> call("fetch_url", "call_0", buildJsonObject { put("url", two) }); else -> say("Both pages say nineteen degrees.") }
                // The lead's server sends its call without any id.
                else -> if (round == 1) unnamed("route_task", buildJsonObject { put("role", "research"); put("task", "Read the two pages") }) else say("两个页面都写着十九度。")
            } }
            model.dispatcher = roles; model.start()
            val run = send(chat(model), "读一下这两个页面：$one $two")
            assertNull("the reply must not fail: " + run.error, run.error?.takeIf { it.contains("DUPLICATE") || it.contains("Tool Calling") || it.contains("共享 Agent") })
            assertEquals("both pages were read", 2, backend.requestCount); assertTrue(run.partial.contains("十九度"))
            // On the wire the member's results still name the id its server gave, twice; the lead's call was completed with one.
            val member = roles.of("member")[2]
            assertEquals(2, Regex("\"tool_call_id\":\"call_0\"").findAll(member).count())
            val lead = MeloJson.parseToJsonElement(roles.of("lead")[1]).jsonObject.getValue("messages").jsonArray.map { it.jsonObject }
            val assigned = lead.first { it["tool_calls"] != null }.getValue("tool_calls").jsonArray.single().jsonObject.text("id")
            assertTrue("the lead's call got an id", assigned.isNotBlank()); assertEquals(assigned, lead.first { it.text("role") == "tool" }.text("tool_call_id"))
        } }
    }

    // Every chat on this phone uses a fixed model, yet each send passed the whole conversation through the
    // Runtime to choose one: a long conversation ended with "共享 Runtime 输入超过上限".
    @Test fun aLongConversationStillGetsAReply() = runBlocking {
        MockWebServer().use { model ->
            val roles = Roles { role, _, _ -> if (role == "check") say(selfContained) else say("好的，简单说：天空蓝是因为散射。") }
            model.dispatcher = roles; model.start()
            val id = chat(model)
            // 2.2 million characters of earlier messages; the last twenty stay well inside every other bound.
            val earlier = (1..55).map { index -> Message(role = if (index % 2 == 1) "user" else "assistant", content = "第 $index 段旧内容。" + "资料".repeat(20_000)) }
            app.repository.editChat(id) { it.copy(messages = earlier) }
            val run = send(id, "用一句话解释天空为什么是蓝色的。")
            assertNull("the reply must not fail: " + run.error, run.error?.takeIf { it.contains("上限") || it.contains("Runtime") })
            assertEquals(run.error, "completed", run.status); assertTrue(run.partial.contains("散射"))
        }
    }

    // A message that shows no language of its own took the phone's system language: in a Chinese conversation
    // on an English phone, the notes Melo writes itself (here the run's summary) switched to English.
    @Test fun aMessageWithNoLanguageOfItsOwnFollowsTheConversation() = runBlocking {
        Assume.assumeFalse("needs a system language other than Chinese", java.util.Locale.getDefault().language == "zh")
        MockWebServer().use { model ->
            val roles = Roles { role, _, _ -> if (role == "check") say(selfContained) else say("42") }
            model.dispatcher = roles; model.start()
            val id = chat(model)
            app.repository.editChat(id) { it.copy(messages = listOf(Message(role = "user", content = "帮我算几道题，只回答数字。"), Message(role = "assistant", content = "好的。"))) }
            val run = send(id, "6 * 7")
            val summary = completion(run).text("summary")
            assertTrue("the summary follows the conversation's language: $summary", Regex("[\\u4e00-\\u9fff]").containsMatchIn(summary))
        }
    }
}
