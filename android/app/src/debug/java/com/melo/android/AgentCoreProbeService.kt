package com.melo.android

import android.app.Service
import android.content.Intent
import android.os.Binder
import com.melo.android.core.SharedCoreRuntime
import kotlinx.coroutines.*

/** Debug-only lifecycle fixture, never exported or included in Release. */
class AgentCoreProbeService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    inner class Probe : Binder() {
        fun evaluate(request: String): Deferred<String> = scope.async {
            SharedCoreRuntime.open(applicationContext).use { it.evaluateJSON(request) }
        }
    }
    override fun onBind(intent: Intent?) = Probe()
    override fun onDestroy() { scope.cancel(); super.onDestroy() }
}
