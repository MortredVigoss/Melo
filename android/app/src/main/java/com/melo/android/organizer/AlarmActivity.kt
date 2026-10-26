package com.melo.android.organizer

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.melo.android.MeloApplication
import com.melo.android.ui.MeloTheme

class AlarmActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState); setShowWhenLocked(true); setTurnScreenOn(true)
        val repository = (application as MeloApplication).organizer
        val key = intent.getStringExtra("key").orEmpty()
        setContent { MeloTheme {
            val state by repository.data.collectAsState()
            val plan = state.planned.find { it.key == key }
            LaunchedEffect(plan, state.deliveries) { if (plan == null || state.deliveries.any { it.key == key && it.status !in setOf("received", "ringing") }) finish() }
            Surface(Modifier.fillMaxSize()) { Column(Modifier.fillMaxSize().padding(32.dp), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
                Text("Melo 提醒", style = MaterialTheme.typography.titleLarge); Spacer(Modifier.height(24.dp)); Text(plan?.title.orEmpty(), style = MaterialTheme.typography.headlineMedium)
                Spacer(Modifier.height(32.dp))
                listOf("稍后 5 分钟" to "snooze5", "稍后 10 分钟" to "snooze10", (if (plan?.kind == "todo") "完成" else "关闭") to (if (plan?.kind == "todo") "complete" else "dismiss"), "关闭提醒" to "dismiss").forEach { (label, action) ->
                    Button(onClick = { if (plan != null) repository.reminders.action(plan, action).send(); finish() }, modifier = Modifier.fillMaxWidth()) { Text(label) }
                }
            } }
        } }
    }
}
