package com.melo.android

import android.app.Activity
import android.os.Bundle
import android.graphics.*
import android.view.*
import android.content.Context
import android.view.accessibility.AccessibilityEvent

/** Offline animated-ad fixture. Never included in Release. */
class DynamicAdFixtureActivity : Activity() {
    lateinit var canvas: AdCanvas
    override fun onCreate(savedInstanceState: Bundle?) { super.onCreate(savedInstanceState); canvas = AdCanvas(this); setContentView(canvas) }
    class AdCanvas(context: Context) : View(context) {
        private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
        var changed = false
        var dim = false
        var clicks = 0
        private var tick = 0
        private val animate = object : Runnable {
            override fun run() { tick++; invalidate(); sendAccessibilityEvent(AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED); if (clicks == 0) postDelayed(this, 100) }
        }
        init { contentDescription = "Animated advertisement"; importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_YES; post(animate) }
        override fun onDraw(c: Canvas) {
            c.drawColor(if (tick % 2 == 0) Color.rgb(30, 60, 90) else Color.rgb(80, 25, 55))
            paint.color = Color.WHITE; paint.textSize = 36f; c.drawText("Advertisement $tick", 30f, height * .6f, paint)
            paint.color = if (changed) Color.RED else if (dim) Color.rgb(215, 215, 215) else Color.BLACK
            c.drawRect(width * .78f, height * .04f, width * .98f, height * .22f, paint)
            paint.color = Color.WHITE; paint.strokeWidth = 8f
            val x = width * .88f; val y = height * .13f
            if (changed) c.drawText("BUY", x - 30, y, paint) else { c.drawLine(x - 24, y - 24, x + 24, y + 24, paint); c.drawLine(x - 24, y + 24, x + 24, y - 24, paint) }
        }
        override fun onTouchEvent(event: MotionEvent): Boolean {
            android.util.Log.i("DynamicAdFixture", "touch=${event.action} x=${event.x} y=${event.y} size=${width}x$height")
            if (event.action == MotionEvent.ACTION_UP && event.x in width*.78f..width*.98f && event.y in height*.04f..height*.22f) { clicks++; contentDescription = "Ad closed"; removeCallbacks(animate); invalidate(); sendAccessibilityEvent(AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED) }
            return true
        }
        override fun onDetachedFromWindow() { removeCallbacks(animate); super.onDetachedFromWindow() }
    }
}
