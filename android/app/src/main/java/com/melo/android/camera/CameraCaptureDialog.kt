package com.melo.android.camera

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.ImageDecoder
import android.net.Uri
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageCapture
import androidx.camera.core.ImageCaptureException
import androidx.camera.view.CameraController
import androidx.camera.view.LifecycleCameraController
import androidx.camera.view.PreviewView
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File

@Composable fun CameraCaptureDialog(onDismiss: () -> Unit, onConfirm: (File) -> Unit) {
    val context = LocalContext.current
    val owner = LocalLifecycleOwner.current
    val draft = remember { PhotoCaptureDraft() }
    val controller = remember { LifecycleCameraController(context).apply { setEnabledUseCases(CameraController.IMAGE_CAPTURE) } }
    val executor = remember(context) { ContextCompat.getMainExecutor(context) }
    fun permitted() = ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED
    var allowed by remember { mutableStateOf(permitted()) }
    var ready by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var photo by remember { mutableStateOf<File?>(null) }
    var previewReady by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var retry by remember { mutableIntStateOf(0) }
    var canSwitch by remember { mutableStateOf(false) }
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { allowed = it }
    LaunchedEffect(Unit) { if (!allowed) permission.launch(Manifest.permission.CAMERA) }
    DisposableEffect(owner) {
        val observer = LifecycleEventObserver { _, event -> if (event == Lifecycle.Event.ON_RESUME) allowed = permitted() }
        owner.lifecycle.addObserver(observer)
        onDispose { owner.lifecycle.removeObserver(observer); draft.cancel() }
    }
    DisposableEffect(controller, owner, allowed, photo, retry) {
        var active = true
        ready = false
        if (allowed && photo == null) {
            controller.initializationFuture.addListener({
                if (active) {
                    try {
                        controller.initializationFuture.get()
                        val back = controller.hasCamera(CameraSelector.DEFAULT_BACK_CAMERA)
                        val front = controller.hasCamera(CameraSelector.DEFAULT_FRONT_CAMERA)
                        check(back || front) { "此设备没有可用相机，请从相册选择图片。" }
                        canSwitch = back && front
                        if (!controller.hasCamera(controller.cameraSelector)) controller.cameraSelector = if (back) CameraSelector.DEFAULT_BACK_CAMERA else CameraSelector.DEFAULT_FRONT_CAMERA
                        controller.bindToLifecycle(owner)
                        error = null; ready = true
                    } catch (_: Exception) { error = "相机暂时不可用，可重试或返回选择相册。" }
                }
            }, executor)
        }
        onDispose { active = false; controller.unbind() }
    }
    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Surface(Modifier.fillMaxSize().testTag("camera-screen")) {
            Column(Modifier.fillMaxSize().safeDrawingPadding().padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    TextButton(onClick = onDismiss) { Text("取消") }
                    Text("拍照", style = MaterialTheme.typography.titleLarge)
                    if (photo == null && canSwitch) TextButton(enabled = ready && !busy, onClick = {
                        try { controller.cameraSelector = if (controller.cameraSelector == CameraSelector.DEFAULT_BACK_CAMERA) CameraSelector.DEFAULT_FRONT_CAMERA else CameraSelector.DEFAULT_BACK_CAMERA }
                        catch (_: Exception) { error = "无法切换相机，请重试。"; retry++ }
                    }) { Text("切换镜头") }
                }
                if (photo != null) CameraPhotoPreview(photo!!, Modifier.weight(1f).fillMaxWidth()) { previewReady = it }
                else if (allowed) AndroidView(factory = { PreviewView(it).apply { implementationMode = PreviewView.ImplementationMode.COMPATIBLE; this.controller = controller } }, modifier = Modifier.weight(1f).fillMaxWidth())
                else {
                    Text("允许相机后即可拍照，也可以返回选择相册。", modifier = Modifier.weight(1f))
                    TextButton(onClick = { context.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${context.packageName}"))) }) { Text("打开系统设置") }
                }
                error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                Text("确认照片后加入草稿，点击发送才会交给模型。", style = MaterialTheme.typography.bodySmall)
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceEvenly) {
                    if (photo != null) {
                        TextButton(onClick = { draft.retake(); photo = null; previewReady = false }) { Text("重拍") }
                        Button(enabled = previewReady, onClick = { draft.confirm()?.let(onConfirm) }, modifier = Modifier.testTag("camera-confirm")) { Text("使用照片") }
                    } else {
                        if (error != null) TextButton(onClick = { retry++ }) { Text("重试") }
                        Button(enabled = ready && !busy, modifier = Modifier.testTag("camera-shutter"), onClick = {
                            try {
                                val file = draft.begin(File(context.cacheDir, "camera-captures")) ?: return@Button
                                busy = true
                                try {
                                    controller.takePicture(ImageCapture.OutputFileOptions.Builder(file).build(), executor, object : ImageCapture.OnImageSavedCallback {
                                        override fun onImageSaved(result: ImageCapture.OutputFileResults) { if (draft.captured(file)) photo = file; busy = false }
                                        override fun onError(exception: ImageCaptureException) { draft.failed(file); busy = false; error = "拍照失败，请重试。" }
                                    })
                                } catch (failure: Exception) { draft.failed(file); throw failure }
                            } catch (_: Exception) { busy = false; error = "拍照失败，请重试。" }
                        }) { Text(if (busy) "正在拍照…" else "拍照") }
                    }
                }
            }
        }
    }
}

@Composable private fun CameraPhotoPreview(file: File, modifier: Modifier, onReady: (Boolean) -> Unit) {
    var bitmap by remember(file) { mutableStateOf<android.graphics.Bitmap?>(null) }
    var failed by remember(file) { mutableStateOf(false) }
    LaunchedEffect(file) {
        bitmap = withContext(Dispatchers.IO) {
            runCatching { ImageDecoder.decodeBitmap(ImageDecoder.createSource(file)) { decoder, info, _ ->
                val scale = maxOf(info.size.width, info.size.height) / 1280.0
                if (scale > 1) decoder.setTargetSize((info.size.width / scale).toInt(), (info.size.height / scale).toInt())
            } }.getOrNull()
        }
        failed = bitmap == null
        onReady(!failed)
    }
    if (bitmap != null) Image(bitmap!!.asImageBitmap(), "拍摄的照片", modifier, contentScale = ContentScale.Fit)
    else Text(if (failed) "无法读取照片，请重拍。" else "正在读取照片…", modifier)
}
