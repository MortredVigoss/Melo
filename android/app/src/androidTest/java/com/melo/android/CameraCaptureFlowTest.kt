package com.melo.android

import android.Manifest
import android.graphics.BitmapFactory
import android.os.Build
import android.util.Base64
import androidx.activity.compose.setContent
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.test.rule.GrantPermissionRule
import com.melo.android.camera.CameraCaptureDialog
import com.melo.android.data.Repository
import com.melo.android.ui.MeloTheme
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test
import java.io.File
import java.util.concurrent.atomic.AtomicReference

class CameraCaptureFlowTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    @get:Rule val cameraPermission: GrantPermissionRule = GrantPermissionRule.grant(Manifest.permission.CAMERA)

    @Test fun nativePreviewRetakeConfirmAndOriginalPreservation() {
        assumeTrue(Build.FINGERPRINT.contains("generic") || Build.MODEL.contains("sdk_gphone"))
        val visible = mutableStateOf(true)
        val result = AtomicReference<File?>()
        compose.runOnUiThread { compose.activity.setContent { MeloTheme { if (visible.value) CameraCaptureDialog(
            onDismiss = { visible.value = false },
            onConfirm = { result.set(it); visible.value = false }
        ) } } }
        fun awaitEnabled(tag: String) {
            compose.waitUntil(60_000) { runCatching { compose.onNodeWithTag(tag).assertIsEnabled(); true }.getOrDefault(false) }
        }
        awaitEnabled("camera-shutter")
        compose.onNodeWithTag("camera-shutter").performClick()
        awaitEnabled("camera-confirm")
        assertNull("Preview must not import or submit an image", result.get())
        compose.onNodeWithText("重拍").performClick()
        awaitEnabled("camera-shutter")
        compose.onNodeWithTag("camera-shutter").performClick()
        awaitEnabled("camera-confirm")
        compose.onNodeWithTag("camera-confirm").performClick()
        compose.waitUntil { result.get() != null }
        compose.onNodeWithTag("camera-screen").assertDoesNotExist()
        val file = result.get()!!
        assertTrue("Dismissal must not delete a confirmed photo before import", file.isFile)
        val original = file.readBytes()
        val repository = Repository(compose.activity)
        val image = runBlocking { repository.importCameraPhoto(file) }
        try {
            val stored = File(compose.activity.filesDir, "images/${image.file}")
            assertArrayEquals(original, stored.readBytes())
            val transfer = Base64.decode(repository.imageData(image), Base64.NO_WRAP)
            assertTrue(transfer.size <= 4 * 1024 * 1024)
            val bitmap = BitmapFactory.decodeByteArray(transfer, 0, transfer.size)
            assertTrue(bitmap.width <= 2048 && bitmap.height <= 2048)
            bitmap.recycle()
            assertArrayEquals("Sending a bounded copy cannot change the original", original, stored.readBytes())
        } finally { file.delete(); repository.discardUnattachedCameraPhoto(image) }
    }

    @Test fun cancelPreviewDoesNotImportAndRemovesTemporaryCapture() {
        assumeTrue(Build.FINGERPRINT.contains("generic") || Build.MODEL.contains("sdk_gphone"))
        val visible = mutableStateOf(true)
        var imports = 0
        compose.runOnUiThread { compose.activity.setContent { MeloTheme { if (visible.value) CameraCaptureDialog(
            onDismiss = { visible.value = false }, onConfirm = { imports++; it.delete() }
        ) } } }
        compose.waitUntil(60_000) { runCatching { compose.onNodeWithTag("camera-shutter").assertIsEnabled(); true }.getOrDefault(false) }
        compose.onNodeWithTag("camera-shutter").performClick()
        compose.waitUntil(60_000) { runCatching { compose.onNodeWithTag("camera-confirm").assertIsEnabled(); true }.getOrDefault(false) }
        compose.onNodeWithText("取消").performClick()
        compose.waitForIdle()
        assertEquals(0, imports)
        assertTrue(File(compose.activity.cacheDir, "camera-captures").listFiles().orEmpty().isEmpty())
    }
}
