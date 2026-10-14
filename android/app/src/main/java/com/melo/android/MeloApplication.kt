package com.melo.android

import android.app.Application
import com.melo.android.chat.ChatEngine
import com.melo.android.data.Repository

class MeloApplication : Application() {
    val repository by lazy { Repository(this) }
    val engine by lazy { ChatEngine(this, repository) }
    override fun onCreate() { super.onCreate(); android.webkit.WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG); engine.initialize() }
}
