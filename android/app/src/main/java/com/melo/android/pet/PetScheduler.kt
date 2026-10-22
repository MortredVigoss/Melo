package com.melo.android.pet

import kotlin.random.Random

enum class PetMode { IDLE, ACTION, CLICK, DRAG, LISTEN, THINK, SPEAK, DONE, FAIL }

/** One clip the player should show. `token` lets late `ended` reports from a replaced clip be ignored. */
data class PetPlayback(val clip: String, val mirrored: Boolean, val mode: PetMode, val token: Int)

/**
 * Pure animation chain, mirroring the desktop pet's rules for 金冬天: idle is the
 * default, every spontaneous action is followed by a rest of 30–60 s where only
 * idle plays, interactions respond immediately, and work states loop until the
 * caller moves on. No Android types so the gate can exercise it on the JVM.
 */
class PetScheduler(private val animations: PetAnimations, private val random: Random = Random.Default, private val now: () -> Long = System::currentTimeMillis) {
    var autoActions = true
    var restMinMs = 30_000L
    var restMaxMs = 60_000L
    var weightIdle = 10
    var weightTurn = 5
    var weightMove = 5
    var facingRight = false
        private set
    var mode = PetMode.IDLE
        private set
    var current: PetPlayback? = null
        private set
    var nextAutoActionAt = 0L
        private set
    private var token = 0
    private var dragging = false
    private var turning = false

    fun start(): PetPlayback { resetRest(); dragging = false; return idle() }
    fun idle(): PetPlayback = play(pick(animations.idle), PetMode.IDLE)
    fun tap(): PetPlayback? = when (mode) {
        PetMode.IDLE, PetMode.ACTION, PetMode.CLICK, PetMode.DONE, PetMode.FAIL -> if (animations.clicks.isEmpty()) null else play(pick(animations.clicks), PetMode.CLICK)
        else -> null
    }
    fun dragStart(): PetPlayback { dragging = true; return play(animations.drag.firstOrNull() ?: animations.idle.first(), PetMode.DRAG) }
    fun dragEnd(): PetPlayback { dragging = false; resetRest(); return idle() }
    fun listen(): PetPlayback = play(animations.turn.firstOrNull() ?: animations.idle.first(), PetMode.LISTEN)
    fun think(): PetPlayback = play(animations.workStatus(0) ?: animations.idle.first(), PetMode.THINK)
    fun wait(): PetPlayback = play(animations.workStatus(1) ?: animations.workStatus(0) ?: animations.idle.first(), PetMode.THINK)
    fun speak(): PetPlayback = play(animations.whisper(2) ?: animations.whisper(0) ?: animations.idle.first(), PetMode.SPEAK)
    fun done(): PetPlayback = play(animations.workStatus(4) ?: animations.idle.first(), PetMode.DONE)
    fun fail(): PetPlayback = play(animations.workStatus(5) ?: animations.idle.first(), PetMode.FAIL)

    /** Called when the player reports a clip finished; returns what to play next, or null when the report is stale. */
    fun clipEnded(endedToken: Int): PetPlayback? {
        val ended = current ?: return null
        if (ended.token != endedToken) return null
        return when (mode) {
            PetMode.DRAG -> if (dragging) play(ended.clip, PetMode.DRAG) else dragEnd()
            PetMode.LISTEN, PetMode.THINK, PetMode.SPEAK -> play(ended.clip, mode)
            PetMode.CLICK, PetMode.ACTION, PetMode.DONE, PetMode.FAIL -> {
                if (turning) { facingRight = !facingRight; turning = false }
                resetRest(); idle()
            }
            PetMode.IDLE -> nextSpontaneous(ended.clip)
        }
    }

    private fun nextSpontaneous(previous: String): PetPlayback {
        if (!autoActions || now() < nextAutoActionAt) return play(pick(animations.idle, previous), PetMode.IDLE)
        val total = 100
        val turn = if (animations.turn.isEmpty()) 0 else weightTurn
        val move = if (animations.moves.actions.isEmpty()) 0 else weightMove
        val roll = random.nextInt(total)
        return when {
            roll < weightIdle -> play(pick(animations.idle, previous), PetMode.IDLE)
            roll < weightIdle + turn -> { turning = true; play(pick(animations.turn, previous), PetMode.ACTION) }
            roll < weightIdle + turn + move -> play(pick(animations.moves.actions.map { it.name }, previous), PetMode.ACTION)
            else -> play(pickCategoryAction(previous), PetMode.ACTION)
        }
    }

    private fun pickCategoryAction(previous: String): String {
        val candidates = animations.categories.filter { it.actions.isNotEmpty() }
        if (candidates.isEmpty()) return pick(animations.idle, previous)
        val eligible = candidates.filterNot { it.noMirror && facingRight }.ifEmpty { candidates }
        var roll = random.nextDouble() * eligible.sumOf { it.weight }.coerceAtLeast(1)
        for (category in eligible) { roll -= category.weight; if (roll <= 0) return pick(category.actions, previous) }
        return pick(eligible.last().actions, previous)
    }

    private fun pick(pool: List<String>, exclude: String? = null): String {
        val entries = if (exclude == null) pool else pool.filterNot { it == exclude }.ifEmpty { pool }
        return entries[random.nextInt(entries.size)]
    }
    private fun resetRest() { nextAutoActionAt = now() + restMinMs + if (restMaxMs > restMinMs) random.nextLong(restMaxMs - restMinMs) else 0L }
    private fun play(clip: String, next: PetMode): PetPlayback {
        if (next != PetMode.ACTION) turning = false
        // Text clips are drawn for the left-facing pose; never mirror them (desktop forces facing left before playing them).
        if (animations.isNoMirror(clip)) facingRight = false
        mode = next
        return PetPlayback(clip, facingRight, next, ++token).also { current = it }
    }
}
