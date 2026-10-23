package com.melo.android

import android.os.Build
import androidx.test.core.app.ApplicationProvider
import androidx.test.platform.app.InstrumentationRegistry
import com.melo.android.chat.*
import com.melo.android.core.*
import com.melo.android.data.*
import com.melo.android.device.DeviceAgentClient
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import okhttp3.mockwebserver.*
import org.junit.*
import org.junit.Assert.*

class SmartRoutingFlowTest {
    private val app get() = ApplicationProvider.getApplicationContext<MeloApplication>()
    @Before fun emulatorOnly() { Assume.assumeTrue(Build.FINGERPRINT.contains("generic") || Build.MODEL.contains("sdk_gphone")) }
    @Test fun sharedFixturesAndRealJudgmentTransportUseOnlySelectedConnection() = runBlocking {
        SharedCoreRuntime.open(app).use { core ->
            val cases=MeloJson.parseToJsonElement(InstrumentationRegistry.getInstrumentation().context.assets.open("model-routing.json").bufferedReader().readText()).jsonArray
            for(case in cases) { val row=case.jsonObject; val result=core.value("modelRouting",buildJsonObject { put("routing",row.getValue("input")) }).jsonObject; val expected=row.getValue("expected").jsonObject
                assertEquals(row.text("name"),expected["model"],result["model"]);assertEquals(row.text("name"),expected["tier"],result["tier"])
            }
            MockWebServer().use { server -> MockWebServer().use { other ->
                server.start();other.start()
                val judgment="""{"complexity":3,"risk":"low","needs":{}}"""
                server.enqueue(MockResponse().setBody(buildJsonObject { put("choices",buildJsonArray { add(buildJsonObject { put("finish_reason","stop");put("message",buildJsonObject { put("role","assistant");put("content",judgment) }) }) }) }.toString()))
                val connection=Connection(id="own",endpoint=server.url("/model").toString(),model="opaque-A",models=listOf("opaque-B","opaque-C"))
                val policy=cases.first().jsonObject.getValue("input").jsonObject.getValue("policy").jsonObject
                val config=SmartRoutingConfig("smart",policy,listOf(connection,connection.copy(id="other",endpoint=other.url("/model").toString())),mapOf("own" to "fixture-key","other" to "never-send"))
                fun session()=SmartRouting(core,config,connection,listOf(Message(role="user",content="比较几个方案")))
                val route=session();route.prepare(DeviceAgentClient(true),SharedRunBudget.open(core)) { _,_,_ -> }
                assertEquals("opaque-B",route.model);assertEquals(1,server.requestCount);assertEquals(0,other.requestCount)
                val request=MeloJson.parseToJsonElement(server.takeRequest().body.readUtf8()).jsonObject;assertEquals("opaque-A",request.text("model"));assertEquals(512,request["max_tokens"]?.jsonPrimitive?.int)
                session().prepare(DeviceAgentClient(true),SharedRunBudget.open(core)) { _,_,_ -> };assertEquals(1,server.requestCount)
                assertTrue(route.escalate(5,0,false,false));assertEquals("opaque-C",route.model);assertFalse(route.escalate(8,4,true,false))
            } }
        }
    }
}
