package com.melo.android.ui

import com.melo.android.data.RunRecord
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

// Layout A (2026-11-06): when the task-space screen (the war room) opens and
// closes by itself. Same rule as desktop-ui/executionPanel.js and the
// iPhone's WarRoomPresentation: a live run opens it once, at its first
// observable step (a tool call, an assignment or an evaluation); a plain
// reply never does; a run the user closed while it ran stays closed; when the
// run ends it hands back to the chat unless the user has touched it. It never
// covers a prompt that needs the user (a call held for permission): it steps
// aside and comes back once that is answered.
class WarRoomPresentation {
    private val autoOpened = mutableSetOf<String>()
    private val dismissed = mutableSetOf<String>()
    private val aside = mutableSetOf<String>()
    var touched = false

    fun shouldOpen(run: RunRecord?, presented: Boolean): Boolean {
        if (run == null || presented || finished(run.status) || run.id in autoOpened || run.id in dismissed || needsUser(run) || !observable(run.sharedScene)) return false
        autoOpened += run.id
        touched = false
        return true
    }

    fun shouldClose(run: RunRecord?): Boolean = run != null && finished(run.status) && run.id in autoOpened && !touched

    /** Leaves the screen for a prompt; this is not the user closing it. */
    fun stepAside(run: RunRecord?) { if (run != null && !finished(run.status)) aside += run.id }

    fun shouldReturn(run: RunRecord?): Boolean {
        if (run == null || finished(run.status) || needsUser(run) || run.id !in aside || run.id in dismissed) return false
        aside -= run.id
        return true
    }

    fun userClosed(run: RunRecord?) { if (run != null && !finished(run.status) && run.id !in aside) dismissed += run.id }

    /** Every opening or closing starts a new showing. A delayed hand-back belongs to the showing it was
     *  scheduled in: closing and reopening in the meantime makes it stale, so it never closes the new page. */
    var showing = 0
        private set
    fun showingChanged() { showing++ }
    fun isCurrent(scheduled: Int) = scheduled == showing

    companion object {
        private val terminal = setOf("completed", "failed", "cancelled", "interrupted", "stopped")
        fun finished(status: String) = status in terminal
        fun needsUser(run: RunRecord?): Boolean {
            val scene = run?.sharedScene ?: return false
            if (finished(run.status)) return false
            val waiting = (scene["operations"] as? JsonArray).orEmpty().any { ((it as? JsonObject)?.get("status") as? JsonPrimitive)?.content == "waiting" }
            return waiting || (scene["pipeline"] as? JsonArray).orEmpty().any { stage ->
                val row = stage as? JsonObject
                (row?.get("id") as? JsonPrimitive)?.content.orEmpty().startsWith("routing:approval:") && (row?.get("status") as? JsonPrimitive)?.content in setOf("waiting", "running", "queued")
            }
        }
        fun observable(scene: JsonObject?): Boolean {
            if (scene == null) return false
            if (((scene["operations"] as? JsonArray)?.size ?: 0) > 0) return true
            return (scene["pipeline"] as? JsonArray).orEmpty().any { stage ->
                val id = ((stage as? JsonObject)?.get("id") as? JsonPrimitive)?.content.orEmpty()
                id.startsWith("internal:") || id.startsWith("task-evaluation:")
            }
        }
    }
}
