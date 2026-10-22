package com.melo.android

import com.melo.android.pet.*
import org.junit.Assert.*
import org.junit.Test
import kotlin.random.Random

/** Mirrors the desktop pet rules: idle by default, rest after each spontaneous action, instant interaction, looping work states. */
class PetSchedulerTest {
    private val animations = PetAnimations(
        idle = listOf("待机呼吸休闲"), turn = listOf("东张西望"), drag = listOf("被鼠标拖拽悬空反馈"),
        clicks = listOf("点击回应-开心跃动", "点击回应-害羞惊讶"),
        moves = PetMoves(actions = listOf(PetMoveAction("螃蟹走路"))),
        categories = listOf(PetCategory("小动作", 20, actions = listOf("悠闲哼歌", "哈欠连天")), PetCategory("文字", 10, noMirror = true, actions = listOf("是啊，吃什么"))),
        events = mapOf("workStatus" to listOf("工作状态-思考冒泡", "工作状态-忙碌点按", "工作状态-清点归档", "工作状态-原地踱步张望", "工作状态-雀跃庆祝", "工作状态-垂头叹气冒汗"), "whisper" to listOf("碎碎念-擦桌碎碎念", "碎碎念-发呆碎碎念", "碎碎念-对屏碎碎念")),
    )
    private class ScriptedRandom(vararg ints: Int, private val doubles: ArrayDeque<Double> = ArrayDeque()) : Random() {
        val ints = ArrayDeque(ints.toList())
        override fun nextBits(bitCount: Int) = 0
        override fun nextInt(until: Int) = (ints.removeFirstOrNull() ?: 0).coerceIn(0, until - 1)
        override fun nextDouble() = doubles.removeFirstOrNull() ?: 0.0
        override fun nextLong(until: Long) = 0L
    }
    private var clock = 0L
    private fun scheduler(random: Random = ScriptedRandom()) = PetScheduler(animations, random) { clock }

    @Test fun startsIdleAndOnlyIdlesUntilTheRestExpires() {
        val pet = scheduler(ScriptedRandom(0, 0, 50, 0))
        val first = pet.start()
        assertEquals("待机呼吸休闲", first.clip); assertEquals(PetMode.IDLE, first.mode); assertFalse(first.mirrored)
        assertTrue(pet.nextAutoActionAt in 30_000L..60_000L)
        clock = 10_000
        val again = pet.clipEnded(first.token)!!
        assertEquals("待机呼吸休闲", again.clip); assertEquals(PetMode.IDLE, again.mode)
        clock = 61_000
        val action = pet.clipEnded(again.token)!!
        assertEquals("悠闲哼歌", action.clip); assertEquals(PetMode.ACTION, action.mode)
        val back = pet.clipEnded(action.token)!!
        assertEquals(PetMode.IDLE, back.mode)
        assertTrue("rest restarts after an action", pet.nextAutoActionAt >= 61_000 + 30_000)
    }

    @Test fun disabledSpontaneousActionsKeepIdlingForever() {
        val pet = scheduler(ScriptedRandom(90, 90, 90)).apply { autoActions = false }
        var playback = pet.start()
        clock = 1_000_000
        repeat(5) { playback = pet.clipEnded(playback.token)!!; assertEquals(PetMode.IDLE, playback.mode) }
    }

    @Test fun turnFlipsFacingAndMirrorsLaterClipsButNeverTextClips() {
        // ints: idle pick at start, the 12 % roll (idle 10 ≤ roll < 15 → turn), the turn pick
        val pet = scheduler(ScriptedRandom(0, 12, 0))
        val idle = pet.start(); clock = 70_000
        val turn = pet.clipEnded(idle.token)!!
        assertEquals("东张西望", turn.clip); assertFalse(turn.mirrored)
        val after = pet.clipEnded(turn.token)!!
        assertTrue("facing flips once the turn clip ends", pet.facingRight); assertTrue(after.mirrored)
        val textOnly = PetScheduler(animations.copy(categories = animations.categories.filter { it.noMirror }), ScriptedRandom(0, 12, 0, 0, 99, 0)) { clock }
        var playback = textOnly.start(); clock += 70_000
        playback = textOnly.clipEnded(playback.token)!!; assertEquals("东张西望", playback.clip)
        playback = textOnly.clipEnded(playback.token)!!; assertTrue(textOnly.facingRight)
        clock += 70_000
        val text = textOnly.clipEnded(playback.token)!!
        assertEquals("是啊，吃什么", text.clip); assertFalse("text clips are drawn left-facing only", text.mirrored); assertFalse(textOnly.facingRight)
    }

    @Test fun tapPlaysAClickReactionThenReturnsToIdleWithAFreshRest() {
        val pet = scheduler(ScriptedRandom(0, 1))
        val idle = pet.start(); clock = 59_000
        val click = pet.tap()!!
        assertEquals("点击回应-害羞惊讶", click.clip); assertEquals(PetMode.CLICK, click.mode)
        assertNull("the replaced idle clip can no longer advance the chain", pet.clipEnded(idle.token))
        val back = pet.clipEnded(click.token)!!
        assertEquals(PetMode.IDLE, back.mode); assertTrue(pet.nextAutoActionAt >= 59_000 + 30_000)
    }

    @Test fun tapsAreIgnoredWhileListeningThinkingOrDragging() {
        val pet = scheduler(); pet.start()
        pet.listen(); assertNull(pet.tap())
        pet.think(); assertNull(pet.tap())
        pet.dragStart(); assertNull(pet.tap())
        assertNull("speaking taps are handled by the caller (stop reading)", pet.speak().let { pet.tap() })
    }

    @Test fun draggingLoopsTheDragClipUntilRelease() {
        val pet = scheduler(); pet.start()
        val drag = pet.dragStart()
        assertEquals("被鼠标拖拽悬空反馈", drag.clip); assertEquals(PetMode.DRAG, drag.mode)
        val again = pet.clipEnded(drag.token)!!
        assertEquals("被鼠标拖拽悬空反馈", again.clip); assertEquals(PetMode.DRAG, again.mode)
        val released = pet.dragEnd()
        assertEquals(PetMode.IDLE, released.mode); assertTrue(pet.nextAutoActionAt >= 30_000)
    }

    @Test fun workStatesLoopUntilMovedOnAndFinishBackInIdle() {
        val pet = scheduler(); pet.start()
        val listen = pet.listen(); assertEquals("东张西望", listen.clip); assertEquals(PetMode.LISTEN, listen.mode)
        assertEquals("东张西望", pet.clipEnded(listen.token)!!.clip)
        val think = pet.think(); assertEquals("工作状态-思考冒泡", think.clip)
        assertEquals(PetMode.THINK, pet.clipEnded(think.token)!!.mode)
        assertEquals("工作状态-忙碌点按", pet.wait().clip)
        val speak = pet.speak(); assertEquals("碎碎念-对屏碎碎念", speak.clip); assertEquals(PetMode.SPEAK, speak.mode)
        assertEquals(PetMode.SPEAK, pet.clipEnded(speak.token)!!.mode)
        val done = pet.done(); assertEquals("工作状态-雀跃庆祝", done.clip)
        assertEquals(PetMode.IDLE, pet.clipEnded(done.token)!!.mode)
        val fail = pet.fail(); assertEquals("工作状态-垂头叹气冒汗", fail.clip)
        assertEquals(PetMode.IDLE, pet.clipEnded(fail.token)!!.mode)
    }

    @Test fun catalogWeightsFallBackWhenPoolsAreEmpty() {
        val bare = PetScheduler(PetAnimations(idle = listOf("待机")), ScriptedRandom(99)) { clock }
        val idle = bare.start(); clock = 100_000
        assertEquals("待机", bare.clipEnded(idle.token)!!.clip)
        assertNull(bare.tap())
        assertEquals("待机", bare.listen().clip); assertEquals("待机", bare.think().clip); assertEquals("待机", bare.speak().clip)
    }
}
