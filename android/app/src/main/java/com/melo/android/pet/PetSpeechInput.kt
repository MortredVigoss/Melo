package com.melo.android.pet

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer

interface PetSpeechListener {
    fun onPartial(text: String)
    fun onResult(text: String)
    fun onError(message: String)
}

/** One listening session at a time; the Debug build can substitute a fixture for emulators without a recognizer. */
interface PetSpeechInput {
    fun start(language: String, listener: PetSpeechListener)
    fun cancel()
    fun destroy()
}

class SystemSpeechInput(private val context: Context) : PetSpeechInput {
    private var recognizer: SpeechRecognizer? = null
    override fun start(language: String, listener: PetSpeechListener) {
        if (!SpeechRecognizer.isRecognitionAvailable(context)) { listener.onError("此设备没有可用的系统语音识别服务。"); return }
        val instance = recognizer ?: runCatching { SpeechRecognizer.createSpeechRecognizer(context) }.getOrNull()?.also { recognizer = it }
        if (instance == null) { listener.onError("无法启动系统语音识别。"); return }
        instance.setRecognitionListener(object : RecognitionListener {
            override fun onReadyForSpeech(params: Bundle?) {}
            override fun onBeginningOfSpeech() {}
            override fun onRmsChanged(rmsdB: Float) {}
            override fun onBufferReceived(buffer: ByteArray?) {}
            override fun onEndOfSpeech() {}
            override fun onEvent(eventType: Int, params: Bundle?) {}
            override fun onError(error: Int) { listener.onError(describe(error)) }
            override fun onPartialResults(partialResults: Bundle?) {
                partialResults?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()?.takeIf { it.isNotBlank() }?.let(listener::onPartial)
            }
            override fun onResults(results: Bundle?) {
                val text = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull().orEmpty().trim()
                if (text.isBlank()) listener.onError(describe(SpeechRecognizer.ERROR_NO_MATCH)) else listener.onResult(text)
            }
        })
        val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
            .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            .putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
            .putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, context.packageName)
        if (language.isNotBlank()) intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, language)
        runCatching { instance.startListening(intent) }.onFailure { listener.onError("无法启动系统语音识别：${it.message}") }
    }
    override fun cancel() { runCatching { recognizer?.cancel() } }
    override fun destroy() { runCatching { recognizer?.destroy() }; recognizer = null }

    companion object {
        fun describe(error: Int): String = when (error) {
            SpeechRecognizer.ERROR_NO_MATCH, SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> "没听清，再双击一次试试。"
            SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "需要麦克风权限：到 Melo → 系统 → 桌宠 授权。"
            SpeechRecognizer.ERROR_RECOGNIZER_BUSY -> "语音识别正忙，稍后再试。"
            SpeechRecognizer.ERROR_NETWORK, SpeechRecognizer.ERROR_NETWORK_TIMEOUT -> "语音识别需要网络。"
            SpeechRecognizer.ERROR_AUDIO -> "麦克风无法使用。"
            SpeechRecognizer.ERROR_CLIENT -> "语音识别被中断。"
            else -> "语音识别失败（$error）。"
        }
    }
}
