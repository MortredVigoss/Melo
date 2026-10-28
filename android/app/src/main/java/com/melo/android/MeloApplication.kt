package com.melo.android

import android.app.Application
import com.melo.android.chat.ChatEngine
import com.melo.android.data.Repository
import com.melo.android.device.DeviceAgent
import com.melo.android.pet.PetPreferences

class MeloApplication : Application() {
    val organizer by lazy { com.melo.android.organizer.OrganizerRepository(this) }
    val repository by lazy { Repository(this) }
    val engine by lazy { ChatEngine(this, repository) }
    val deviceAgent by lazy { DeviceAgent(this, repository) }
    val petPreferences by lazy { PetPreferences(this) }
    override fun onCreate() {
        super.onCreate()
        // Do not eagerly load the WebView provider before native startup.
        // WebView 113+ derives debugging from the app's debuggable flag.
        engine.initialize()
        organizer.start()
    }
}
