package com.melo.android

import com.melo.android.core.AgentLoopDefaults
import kotlinx.serialization.json.*
import org.junit.Assert.assertEquals
import org.junit.Test

class AgentLoopDefaultsTest {
    @Test fun generatedUiValuesMatchThePortableContract() {
        val raw = javaClass.classLoader!!.getResourceAsStream("agent-loop.json")!!.bufferedReader().use { it.readText() }
        val contract = Json.parseToJsonElement(raw).jsonObject
        val loop = contract.getValue("loop").jsonObject
        assertEquals(loop.getValue("maxIterations").jsonPrimitive.int, AgentLoopDefaults.maxIterations)
        assertEquals(loop.getValue("minIterations").jsonPrimitive.int, AgentLoopDefaults.minIterations)
        assertEquals(contract.getValue("guardLimits").jsonObject.getValue("maxRounds").jsonPrimitive.int, AgentLoopDefaults.maxRounds)
        assertEquals(contract.getValue("budget").jsonObject.getValue("deadlineMs").jsonPrimitive.int, AgentLoopDefaults.deadlineMs)
        assertEquals(loop.getValue("deepTask").jsonObject.getValue("deadlineMs").jsonPrimitive.int, AgentLoopDefaults.deepDeadlineMs)
    }
}
