package com.melo.android.organizer

import android.app.*
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.*
import android.os.*
import androidx.core.app.ServiceCompat
import com.melo.android.MeloApplication
import kotlinx.coroutines.*

/** Bounded alarm audio; no DND bypass or microphone permission. */
class ReminderService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var player: MediaPlayer? = null
    private var vibrator: Vibrator? = null
    private var timeout: Job? = null
    private var focus: AudioFocusRequest? = null
    override fun onBind(intent: Intent?) = null
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == "stop") { stopSelf(); return START_NOT_STICKY }
        val key = intent?.getStringExtra("key") ?: return START_NOT_STICKY.also { stopSelf() }
        val repository = (application as MeloApplication).organizer
        val plan = repository.data.value.planned.find { it.key == key }
        if (plan == null || repository.data.value.deliveries.none { it.key == key && it.revision == plan.revision && it.status == "received" }) { stopSelf(); return START_NOT_STICKY }
        stopAudio()
        activeKey = key
        ServiceCompat.startForeground(this, ReminderEngine.notificationId(key), repository.reminders.notification(plan, true), ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
        scope.launch {
            val audio = getSystemService(AudioManager::class.java)
            val attrs = AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ALARM).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build()
            focus = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT).setAudioAttributes(attrs).setOnAudioFocusChangeListener { change -> if (change == AudioManager.AUDIOFOCUS_LOSS) stopSelf() }.build()
            val audioStarted = if (audio.requestAudioFocus(focus!!) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED) runCatching {
                player = MediaPlayer().apply { setAudioAttributes(attrs); setWakeMode(this@ReminderService, PowerManager.PARTIAL_WAKE_LOCK); setDataSource(this@ReminderService, RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM) ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION)); isLooping = true; prepare(); start() }
                vibrator = getSystemService(Vibrator::class.java).also { it.vibrate(VibrationEffect.createWaveform(longArrayOf(0, 600, 400), 0)) }
            }.isSuccess else false
            repository.update { state -> state.copy(deliveries = state.deliveries.map { if (it.key == key && it.status == "received") it.copy(status = if (audioStarted) "ringing" else "posted") else it }) }
            timeout?.cancel()
            timeout = scope.launch { delay(120000); repository.acknowledge(key, "timed_out", revision = plan.revision, fireAt = plan.fireAt); stopSelf() }
        }
        return START_NOT_STICKY
    }
    private fun stopAudio() { timeout?.cancel(); player?.release(); player = null; vibrator?.cancel(); vibrator = null; focus?.let { getSystemService(AudioManager::class.java).abandonAudioFocusRequest(it) }; focus = null }
    override fun onDestroy() { stopAudio(); activeKey = null; scope.cancel(); stopForeground(STOP_FOREGROUND_REMOVE); super.onDestroy() }
    companion object { @Volatile var activeKey: String? = null; private set }
}
