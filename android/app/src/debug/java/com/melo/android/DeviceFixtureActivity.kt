package com.melo.android

import android.app.Activity
import android.os.Bundle
import android.text.InputType
import android.widget.*

/** Local runtime fixture, excluded from the delivered Release APK. */
class DeviceFixtureActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Launch with a deterministic viewport. Input tests explicitly tap the
        // editor; a keyboard restored from a previous app must not resize a
        // coordinate-test window after its initial observation.
        window.setSoftInputMode(android.view.WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_HIDDEN or android.view.WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE)
        val column = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(30, 100, 30, 30) }
        val count = TextView(this).apply { text = "Count 0"; textSize = 24f }
        var clicks = 0
        val target = Button(this).apply { text = "Target button"; isAllCaps = false; setOnClickListener { count.text = "Count ${++clicks}" } }
        val input = EditText(this).apply {
            hint = "Fixture input"; contentDescription = "Fixture input"; setSingleLine(true)
            imeOptions = android.view.inputmethod.EditorInfo.IME_ACTION_SEARCH
            setImeActionLabel("Search", android.view.inputmethod.EditorInfo.IME_ACTION_SEARCH)
            setOnEditorActionListener { view, action, _ ->
                if (action == android.view.inputmethod.EditorInfo.IME_ACTION_SEARCH) { count.text = "Search result: ${view.text}"; true } else false
            }
        }
        val password = EditText(this).apply { inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD; setText("fixture-password-hidden"); contentDescription = "Fixture password" }
        column.addView(count); column.addView(target); column.addView(input); column.addView(password)
        setContentView(column)
    }
}
