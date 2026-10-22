package com.melo.android

import com.melo.android.pet.*
import org.junit.Assert.*
import org.junit.Test
import java.io.File

/** The committed catalog must describe a complete, fetchable media set for both skins. */
class PetCatalogTest {
    private val catalog = PetCatalog.parse(File("src/main/assets/pet/catalog.json").readText())

    @Test fun bothSkinsCoverEveryActionTheChainCanAskFor() {
        assertEquals(1, catalog.version)
        assertEquals(480, catalog.stage.width); assertEquals(270, catalog.stage.height)
        assertEquals(setOf("winter", "fish"), catalog.skins.keys)
        val names = catalog.animations.names()
        assertEquals(catalog.actionCount, names.size)
        assertTrue(names.size >= 100)
        for (skin in catalog.skins.values) {
            val missing = names.filterNot { skin.clips.containsKey(it) }
            assertEquals("${skin.id} is missing $missing", emptyList<String>(), missing)
            assertEquals(skin.clipCount, skin.clips.size)
            assertEquals(skin.totalBytes, skin.clips.values.sumOf { it.bytes })
            assertTrue(skin.sourceRevision.isNotBlank())
            for ((name, clip) in skin.clips) {
                assertTrue("$name file", Regex("^skins/${skin.id}/[a-z][0-9]{3}\\.webm$").matches(clip.file))
                assertTrue("$name hash", Regex("^[a-f0-9]{64}$").matches(clip.sha256))
                assertTrue("$name duration", clip.duration > 1.0 && clip.duration < 20.0)
                assertTrue("$name fps", clip.fps >= 24.0 && clip.fps <= 30.0)
                assertTrue("$name box ${clip.box}", clip.box.measured && clip.box.w > 0 && clip.box.h > 0 && clip.box.x >= 0 && clip.box.y >= 0 && clip.box.x + clip.box.w <= 480 && clip.box.y + clip.box.h <= 270)
            }
            assertEquals("asset names are unique", skin.clips.size, skin.clips.values.map { it.file }.toSet().size)
        }
        assertEquals("金冬天", catalog.skins.getValue("winter").name); assertEquals("大肥鱼", catalog.skins.getValue("fish").name)
        assertEquals("winter", PetCatalog.DEFAULT_SKIN); assertEquals(catalog.skins.getValue("winter"), catalog.skin("unknown"))
    }

    @Test fun workStatusAndWhisperPoolsFollowTheDesktopOrder() {
        assertEquals("工作状态-思考冒泡", catalog.animations.workStatus(0))
        assertEquals("工作状态-雀跃庆祝", catalog.animations.workStatus(4))
        assertEquals("工作状态-垂头叹气冒汗", catalog.animations.workStatus(5))
        assertEquals("碎碎念-对屏碎碎念", catalog.animations.whisper(2))
        assertTrue(catalog.animations.isNoMirror("是啊，吃什么")); assertFalse(catalog.animations.isNoMirror("待机呼吸休闲"))
        assertEquals(6, catalog.workStatusTexts.size)
    }

    @Test fun theBodyBoxIsSmallerThanTheStageSoTheOverlayStaysOutOfTheWay() {
        for (skin in catalog.skins.values) {
            val idle = skin.clips.getValue(catalog.animations.idle.first()).box
            assertTrue("${skin.id} idle box $idle", idle.w <= 240 && idle.h <= 240 && idle.x > 100)
        }
    }

    @Test fun mediaIsPublishedAsAReleaseBundleForMachinesWithoutTheSource() {
        assertTrue(catalog.bundle.url, catalog.bundle.url.startsWith("https://github.com/MortredVigoss/Melo/releases/download/"))
        assertTrue(Regex("^[a-f0-9]{64}$").matches(catalog.bundle.sha256))
        assertTrue(catalog.bundle.bytes > 50L * 1024 * 1024)
        assertTrue(catalog.bundle.file.endsWith(".zip") && catalog.bundle.url.endsWith(catalog.bundle.file))
    }
}
