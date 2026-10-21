package com.melo.android

import com.melo.android.camera.PhotoCaptureDraft
import org.junit.Assert.*
import org.junit.Test
import java.nio.file.Files

class PhotoCaptureDraftTest {
    @Test fun cancelledCaptureRejectsLateResultAndDeletesTemporaryBytes() {
        val root = Files.createTempDirectory("camera-test").toFile()
        try {
            val draft = PhotoCaptureDraft()
            val file = draft.begin(root)!!
            assertNull(draft.begin(root))
            draft.cancel()
            file.writeText("late camera callback")
            assertFalse(draft.captured(file))
            assertFalse(file.exists())
            assertNull(draft.confirm())
            assertNull(draft.begin(root))
        } finally { root.deleteRecursively() }
    }
    @Test fun retakeDeletesOldPhotoAndConfirmTransfersExactlyOnce() {
        val root = Files.createTempDirectory("camera-test").toFile()
        try {
            val draft = PhotoCaptureDraft()
            val old = draft.begin(root)!!.also { it.writeText("old") }
            assertTrue(draft.captured(old))
            assertNull(draft.begin(root))
            draft.retake(); assertFalse(old.exists())
            val fresh = draft.begin(root)!!.also { it.writeText("new full-resolution bytes") }
            assertTrue(draft.captured(fresh))
            assertFalse(draft.captured(fresh))
            assertEquals(fresh, draft.confirm())
            assertNull(draft.confirm())
            draft.cancel(); draft.failed(fresh)
            assertFalse(draft.captured(fresh))
            assertEquals("new full-resolution bytes", fresh.readText())
        } finally { root.deleteRecursively() }
    }
    @Test fun captureFailureAllowsRetryAndCancellationRemovesPreview() {
        val root = Files.createTempDirectory("camera-test").toFile()
        try {
            val draft = PhotoCaptureDraft()
            val failed = draft.begin(root)!!
            draft.failed(failed); assertFalse(failed.exists())
            val retry = draft.begin(root)!!
            assertTrue(draft.captured(retry))
            draft.cancel(); assertFalse(retry.exists())
        } finally { root.deleteRecursively() }
    }
}
