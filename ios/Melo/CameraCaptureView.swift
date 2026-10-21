import SwiftUI
import AVFoundation
import UniformTypeIdentifiers

struct CameraDraftRequest: Identifiable {
    let id = UUID()
    let chatID: String
}

/// The system camera stays inside Melo and owns capture, lens switching,
/// retake and confirmation. Only the confirmed still image leaves this view.
struct CameraCaptureView: View {
    @Environment(\.scenePhase) private var scenePhase
    @State private var allowed = false
    @State private var unavailable = false
    let onComplete: (Result<Data?, Error>) -> Void

    var body: some View {
        Group {
            if allowed {
                NativePhotoCamera(onComplete: onComplete).ignoresSafeArea()
            } else {
                VStack(spacing: 24) {
                    Image(systemName: "camera").font(.largeTitle).foregroundStyle(meloGold)
                    Text(LocalizedStringKey(unavailable ? "此设备没有可用相机，请从相册选择图片。" : "允许相机后即可拍照，也可以返回选择相册。"))
                        .multilineTextAlignment(.center)
                    Text("确认照片后加入草稿，点击发送才会交给模型。").font(.caption).foregroundStyle(.secondary)
                    if !unavailable {
                        Button("在系统设置中管理") {
                            if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
                        }
                    }
                    Button("取消") { onComplete(.success(nil)) }
                }.padding(28).frame(maxWidth: .infinity, maxHeight: .infinity).background(MeloTheme.dialog)
            }
        }
        .task(id: scenePhase) {
            guard scenePhase == .active else { return }
            unavailable = !UIImagePickerController.isSourceTypeAvailable(.camera)
            guard !unavailable else { return }
            let status = AVCaptureDevice.authorizationStatus(for: .video)
            var granted = status == .authorized
            if status == .notDetermined { granted = await AVCaptureDevice.requestAccess(for: .video) }
            guard !Task.isCancelled else { return }
            allowed = granted
        }
    }

}

private struct NativePhotoCamera: UIViewControllerRepresentable {
    let onComplete: (Result<Data?, Error>) -> Void
    func makeCoordinator() -> Coordinator { Coordinator(onComplete: onComplete) }
    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.mediaTypes = [UTType.image.identifier]
        picker.cameraCaptureMode = .photo
        picker.allowsEditing = false
        picker.delegate = context.coordinator
        return picker
    }
    func updateUIViewController(_ picker: UIImagePickerController, context: Context) {}
    static func dismantleUIViewController(_ picker: UIImagePickerController, coordinator: Coordinator) {
        coordinator.finished = true
        picker.delegate = nil
    }
    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        var finished = false
        let onComplete: (Result<Data?, Error>) -> Void
        init(onComplete: @escaping (Result<Data?, Error>) -> Void) { self.onComplete = onComplete }
        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) { finish(.success(nil)) }
        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            guard !finished else { return }
            guard let image = info[.originalImage] as? UIImage, let data = image.jpegData(compressionQuality: 0.95) else {
                finish(.failure(MeloError.message("无法读取拍摄的照片，请重试。"))); return
            }
            finish(.success(data))
        }
        private func finish(_ result: Result<Data?, Error>) {
            guard !finished else { return }
            finished = true
            onComplete(result)
        }
    }
}
