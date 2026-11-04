package com.melo.android

import android.app.Activity
import android.os.Bundle
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView

/** Local synthetic navigation; no location, accounts or real trip. Debug only. */
class NavigationFixtureActivity : Activity() {
    private var selected = ""
    private var unexpected = 0
    private fun record(active: Boolean) {
        getSharedPreferences("navigation-fixture", MODE_PRIVATE).edit().putString("destination", selected)
            .putBoolean("active", active).putInt("unexpected", unexpected).apply()
    }
    private fun page(title: String, buttons: List<Pair<String, () -> Unit>>) {
        val column = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(24, 110, 24, 24) }
        column.addView(TextView(this).apply { text = title; textSize = 24f })
        for ((label, action) in buttons) column.addView(Button(this).apply { text = label; isAllCaps = false; setOnClickListener { action() } })
        setContentView(column)
    }
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        record(false)
        page("Navigation Fixture — Saved places", listOf("Saved Home" to { choose("Home") }, "Saved Work" to { choose("Work") }))
    }
    private fun choose(place: String) {
        selected = place; record(false)
        page("Destination: $place", listOf("Start driving" to { active() }))
    }
    private fun active() {
        record(true)
        // Deliberately remove the destination label. The agent must retain the
        // earlier selected-place fact rather than explore/close this screen.
        page("Navigation active", listOf("Route details" to { unexpected++; record(true) }, "Close navigation" to { unexpected++; record(false) }))
    }
}
