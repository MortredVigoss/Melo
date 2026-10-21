package com.melo.android.camera

import java.io.File

/** Owns only this camera session's temporary files. After confirmation the
 * caller owns the file; cancellation and late callbacks cannot resurrect it. */
class PhotoCaptureDraft {
    private var capturing: File? = null
    private var preview: File? = null
    private var closed = false
    private var released: File? = null

    fun begin(directory: File): File? {
        if (closed || capturing != null || preview != null) return null
        check(directory.isDirectory || directory.mkdirs()) { "Cannot create camera temporary directory" }
        return File.createTempFile("capture-", ".jpg", directory).also { capturing = it }
    }
    fun captured(file: File): Boolean {
        if (file == released || file == preview) return false
        if (closed || file != capturing) { file.delete(); return false }
        capturing = null; preview = file
        return true
    }
    fun failed(file: File) {
        if (file == released || file == preview) return
        if (file == capturing) capturing = null
        file.delete()
    }
    fun retake() { preview?.delete(); preview = null }
    fun confirm(): File? {
        if (closed) return null
        val file = preview ?: return null
        preview = null; closed = true
        released = file
        return file
    }
    fun cancel() {
        closed = true
        capturing?.delete(); capturing = null
        preview?.delete(); preview = null
    }
}
