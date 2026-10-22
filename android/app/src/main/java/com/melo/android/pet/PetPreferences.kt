package com.melo.android.pet

import android.content.Context
import android.content.SharedPreferences
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Local-only pet preferences. They never join the portable snapshot or export,
 * and reading them must not wait for the Room repository: the foreground service
 * can be restarted by the system before the chat engine has loaded.
 */
data class PetSettings(
    val enabled: Boolean = false,
    val skin: String = PetCatalog.DEFAULT_SKIN,
    /** Stage width in dp; the character body is roughly 40 % of it. */
    val sizeDp: Int = DEFAULT_SIZE_DP,
    val autoActions: Boolean = true,
    /** Base rest between spontaneous actions; the actual pause is rest…2×rest seconds (desktop: 30–60 s). */
    val restSeconds: Int = DEFAULT_REST_SECONDS,
    /** BCP-47 tag for system speech recognition and reading; blank follows the device language. */
    val speechLanguage: String = "",
    val speakReplies: Boolean = true,
    val chatId: String = "",
    /** Stage origin in screen pixels; negative means "not placed yet". */
    val anchorX: Int = -1,
    val anchorY: Int = -1,
    val edge: String = "right",
) {
    val restMinMs get() = restSeconds.coerceIn(MIN_REST_SECONDS, MAX_REST_SECONDS) * 1000L
    val restMaxMs get() = restMinMs * 2
    companion object {
        const val DEFAULT_SIZE_DP = 220
        const val MIN_SIZE_DP = 140
        const val MAX_SIZE_DP = 360
        const val DEFAULT_REST_SECONDS = 30
        const val MIN_REST_SECONDS = 10
        const val MAX_REST_SECONDS = 180
        val LANGUAGES = listOf("" to "跟随系统", "zh-CN" to "中文（普通话）", "yue-HK" to "粤语", "en-US" to "English", "ja-JP" to "日本語")
        fun normalize(settings: PetSettings) = settings.copy(sizeDp = settings.sizeDp.coerceIn(MIN_SIZE_DP, MAX_SIZE_DP), restSeconds = settings.restSeconds.coerceIn(MIN_REST_SECONDS, MAX_REST_SECONDS))
    }
}

class PetPreferences(context: Context) {
    private val store: SharedPreferences = context.applicationContext.getSharedPreferences("pet", Context.MODE_PRIVATE)
    private val mutable = MutableStateFlow(read())
    val settings: StateFlow<PetSettings> = mutable.asStateFlow()
    val value get() = mutable.value

    fun update(transform: (PetSettings) -> PetSettings): PetSettings {
        val next = PetSettings.normalize(transform(mutable.value))
        store.edit().putBoolean("enabled", next.enabled).putString("skin", next.skin).putInt("sizeDp", next.sizeDp).putBoolean("autoActions", next.autoActions)
            .putInt("restSeconds", next.restSeconds).putString("speechLanguage", next.speechLanguage).putBoolean("speakReplies", next.speakReplies)
            .putString("chatId", next.chatId).putInt("anchorX", next.anchorX).putInt("anchorY", next.anchorY).putString("edge", next.edge).apply()
        mutable.value = next
        return next
    }

    private fun read(): PetSettings {
        val defaults = PetSettings()
        return PetSettings.normalize(PetSettings(
            enabled = store.getBoolean("enabled", defaults.enabled), skin = store.getString("skin", defaults.skin) ?: defaults.skin,
            sizeDp = store.getInt("sizeDp", defaults.sizeDp), autoActions = store.getBoolean("autoActions", defaults.autoActions),
            restSeconds = store.getInt("restSeconds", defaults.restSeconds), speechLanguage = store.getString("speechLanguage", defaults.speechLanguage) ?: "",
            speakReplies = store.getBoolean("speakReplies", defaults.speakReplies), chatId = store.getString("chatId", "") ?: "",
            anchorX = store.getInt("anchorX", -1), anchorY = store.getInt("anchorY", -1), edge = store.getString("edge", defaults.edge) ?: defaults.edge,
        ))
    }
}
