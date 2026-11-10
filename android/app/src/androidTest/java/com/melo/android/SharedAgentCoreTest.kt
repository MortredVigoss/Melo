package com.melo.android

import android.content.Intent
import androidx.test.core.app.ApplicationProvider
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.rule.ServiceTestRule
import com.melo.android.core.SharedCoreRuntime
import com.melo.android.core.SharedRunBudget
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

class SharedAgentCoreTest {
    // 2026-11-10. A turn that has not stopped has no reason. The reducer keeps it as JSON null, which was
    // read as the word "null" and reached the stop text and the receipt of a reply.
    @Test fun aRunningTurnHasNoStopReason() = kotlinx.coroutines.runBlocking {
        com.melo.android.core.SharedCoreTurn.open(androidx.test.core.app.ApplicationProvider.getApplicationContext(), "reason-run", "reason-turn", listOf("web_search"), rounds = 2).use { turn ->
            org.junit.Assert.assertTrue(turn.active); org.junit.Assert.assertEquals("", turn.reason)
            org.junit.Assert.assertEquals("", turn.rejection("missing")); org.junit.Assert.assertEquals("", turn.rejectionNote("missing"))
        }
    }
    private val app get() = ApplicationProvider.getApplicationContext<MeloApplication>()
    @get:Rule val service = ServiceTestRule()

    @Test fun samePackagedBundlePassesTheSharedConformanceFixtures() = runBlocking {
        val fixtures = InstrumentationRegistry.getInstrumentation().context.assets.open("conformance.json").bufferedReader().use { Json.parseToJsonElement(it.readText()).jsonArray }
        SharedCoreRuntime.open(app).use { runtime ->
            assertEquals(64, runtime.bundleHash.length)
            for (fixture in fixtures) {
                val row = fixture.jsonObject
                val actual = runtime.evaluate(row.getValue("input").jsonObject)
                assertEquals(row.getValue("name").jsonPrimitive.content, row["ok"], actual["ok"])
                val value = actual[if (actual["ok"]?.jsonPrimitive?.boolean == true) "value" else "error"]!!
                if (row.getValue("expected") !is JsonObject) assertEquals(row["name"].toString(), row["expected"], value)
                else for ((key, expected) in row.getValue("expected").jsonObject) assertEquals("${row["name"]}: $key", expected, value.jsonObject[key])
            }
        }
    }

    @Test fun taskDatasetMatchesCanonicalEventsAndEmitsComparableReport() = runBlocking {
        val assets = InstrumentationRegistry.getInstrumentation().context.assets
        val source = assets.open("tasks.json").use { it.readBytes() }
        val dataset = Json.parseToJsonElement(source.toString(Charsets.UTF_8)).jsonObject
        val expected = assets.open("tasks.expected.json").bufferedReader().use { Json.parseToJsonElement(it.readText()) }
        SharedCoreRuntime.open(app).use { runtime ->
            val started = System.nanoTime()
            val reply = runtime.evaluate(buildJsonObject {
                put("version", 1); put("op", "taskReplay"); put("dataset", dataset)
            })
            val elapsed = (System.nanoTime() - started) / 1_000_000.0
            assertEquals(true, reply["ok"]?.jsonPrimitive?.boolean)
            val result = reply.getValue("value").jsonObject
            assertEquals(true, result["passed"]?.jsonPrimitive?.boolean)
            assertEquals("Shared task events, tools, provenance and fixture costs", expected, result)
            val digest = java.security.MessageDigest.getInstance("SHA-256").digest(source).joinToString("") { "%02x".format(it) }
            val report = buildJsonObject {
                put("version", 1); put("host", "Android-JavaScriptSandbox")
                put("evaluationId", requireNotNull(InstrumentationRegistry.getArguments().getString("taskEvaluationId")))
                put("datasetSha256", digest); put("bundleSha256", runtime.bundleHash)
                put("replayElapsedMs", elapsed); put("report", result)
            }
            val endpoint = requireNotNull(InstrumentationRegistry.getArguments().getString("taskReportEndpoint"))
            val request = Request.Builder().url(endpoint)
                .header("X-Melo-Evaluation", report.getValue("evaluationId").jsonPrimitive.content)
                .post(report.toString().toRequestBody("application/json".toMediaType())).build()
            OkHttpClient().newCall(request).execute().use { response ->
                assertEquals("The fixture Host must receive this run's actual report", 204, response.code)
            }
        }
    }

    @Test fun namedDataPreservesChineseAndCannotExecuteMessageContents() = runBlocking {
        SharedCoreRuntime.open(app).use { runtime ->
            val result = runtime.evaluate(buildJsonObject {
                put("version", 1); put("op", "plan")
                put("request", buildJsonObject { put("text", "');throw new Error('injected');// 中文 😀") })
            })
            assertEquals(true, result["ok"]!!.jsonPrimitive.boolean)
        }
    }

    @Test fun closingOneChatDoesNotCloseAnotherChatOrTheApplicationSandbox() = runBlocking {
        val first = SharedCoreRuntime.open(app)
        SharedCoreRuntime.open(app).use { second ->
            first.close()
            assertTrue(runCatching { first.evaluateJSON("{}") }.isFailure)
            assertTrue(second.evaluate(buildJsonObject { put("version", 1); put("op", "hello") })["ok"]!!.jsonPrimitive.boolean)
        }
        SharedCoreRuntime.open(app).use { assertTrue(it.evaluateJSON("{\"version\":1,\"op\":\"hello\"}").contains("melo-local-core")) }
    }

    // 2026-11-10. An isolate closed in the middle of an evaluation took down the sandbox process that
    // every isolate of the app shares: a reply stopped while the Core was working made the next
    // evaluation of any chat fail with SandboxDeadException ("共享 Runtime 执行中断"), about once in
    // sixty stops on the emulator. The stops below land inside a long evaluation; the witness is
    // another chat's Runtime, which has to keep answering.
    @Test fun anEvaluationStoppedMidwayNeverTakesTheOtherRuntimesDown() = runBlocking {
        val dataset = InstrumentationRegistry.getInstrumentation().context.assets.open("tasks.json").bufferedReader().use { Json.parseToJsonElement(it.readText()).jsonObject }
        val long = buildJsonObject { put("version", 1); put("op", "taskReplay"); put("dataset", dataset) }
        val hello = buildJsonObject { put("version", 1); put("op", "hello") }
        SharedCoreRuntime.open(app).use { witness ->
            var midway = 0
            repeat(60) { round ->
                val runtime = SharedCoreRuntime.open(app)
                val job = launch(Dispatchers.Default) { runtime.evaluate(long) }
                delay(1L + round % 10 * 2)
                job.cancelAndJoin()
                // A Runtime closes itself only when the stop interrupted its evaluation.
                if (runtime.isClosed) midway++
                runtime.close()
                assertEquals("after stop $round", true, witness.evaluate(hello)["ok"]?.jsonPrimitive?.boolean)
            }
            assertTrue("the stops have to land inside the evaluation to prove anything: $midway of 60", midway >= 10)
            delay(1_000) // a sandbox that is going down is reported a moment later
            assertEquals(true, witness.evaluate(hello)["ok"]?.jsonPrimitive?.boolean)
            SharedCoreRuntime.open(app).use { fresh -> assertEquals(true, fresh.evaluate(hello)["ok"]?.jsonPrimitive?.boolean) }
        }
    }

    // The same for a Runtime stopped while it is still loading the packaged bundle, which is where
    // a stop lands when a member's turn is being opened.
    @Test fun aRuntimeStoppedWhileItOpensNeverTakesTheOtherRuntimesDown() = runBlocking {
        val hello = buildJsonObject { put("version", 1); put("op", "hello") }
        SharedCoreRuntime.open(app).use { witness ->
            var unfinished = 0
            repeat(80) { round ->
                val opening = async(Dispatchers.Default) { SharedCoreRuntime.open(app) }
                delay(1L + round % 20 * 3)
                opening.cancel()
                val opened = runCatching { opening.await() }.getOrNull()
                if (opened == null) unfinished++ else opened.close()
                assertEquals("after stop $round", true, witness.evaluate(hello)["ok"]?.jsonPrimitive?.boolean)
            }
            assertTrue("the stops have to land while a Runtime opens to prove anything: $unfinished of 80", unfinished >= 15)
            delay(1_000)
            assertEquals(true, witness.evaluate(hello)["ok"]?.jsonPrimitive?.boolean)
            SharedCoreRuntime.open(app).use { fresh -> assertEquals(true, fresh.evaluate(hello)["ok"]?.jsonPrimitive?.boolean) }
        }
    }

    @Test fun serviceRunsCoreWithoutAnActivityOrVisibleWebView() = runBlocking {
        val binder = service.bindService(Intent(app, AgentCoreProbeService::class.java)) as AgentCoreProbeService.Probe
        val result = withTimeout(15_000) { binder.evaluate("{\"version\":1,\"op\":\"hello\"}").await() }
        assertTrue(result.contains("melo-local-core"))
    }
    @Test fun childBudgetsChargeParentAndAtomicAdmissionDoesNotOverrunTools() = runBlocking {
        SharedCoreRuntime.open(app).use { runtime ->
            val parent = SharedRunBudget.open(runtime, options = buildJsonObject { put("maxToolCalls", 1) })
            val first = SharedRunBudget.open(runtime, parent, buildJsonObject { put("maxToolCalls", 20) })
            val second = SharedRunBudget.open(runtime, parent)
            val effects = java.util.concurrent.atomic.AtomicInteger()
            val results = listOf(first, second).map { budget -> async { runCatching { budget.effect { effects.incrementAndGet() } }.isSuccess } }.awaitAll()
            assertEquals(1, effects.get())
            assertEquals(1, results.count { it })
            assertTrue(runCatching { parent.check() }.isFailure)
            assertTrue(runCatching { first.check() }.isFailure)
        }
    }

    @Test fun unavailableBudgetPolicyAndDeadlineNeverPermitEffects() = runBlocking {
        val runtime = SharedCoreRuntime.open(app)
        val budget = SharedRunBudget.open(runtime)
        runtime.close()
        var effects = 0
        assertTrue(runCatching { budget.effect { effects++ } }.isFailure)
        assertEquals(0, effects)
        SharedCoreRuntime.open(app).use { live ->
            val short = SharedRunBudget.open(live, options = buildJsonObject { put("deadlineMs", 1) })
            delay(20)
            assertTrue(runCatching { short.model(10) { effects++ } }.isFailure)
            assertEquals(0, effects)
        }
    }

}
