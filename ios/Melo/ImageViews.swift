import SwiftUI
import PhotosUI
import Vision

struct LocalImageThumbnail: View {
    let image: LocalImage
    let library: ImageLibrary
    @State private var thumbnail: UIImage?
    var body: some View {
        Group {
            if let thumbnail { Image(uiImage:thumbnail).resizable().scaledToFit() }
            else { Image(systemName:"photo").foregroundStyle(.secondary).overlay(alignment:.bottom) { Text("图片暂不可读").font(.system(size:9)) } }
        }
        .task(id:image.id) {
            guard let data = try? library.data(image) else { return }
            let bitmap = await Task.detached(priority:.userInitiated) { try? ImageLibrary.decoded(data,maxDimension:512) }.value
            if let bitmap { thumbnail=UIImage(cgImage:bitmap) }
        }
    }
}
struct ImageComposerBar: View {
    @EnvironmentObject var store: ChatStore
    @Binding var plan: ImageTaskPlan
    @Binding var importID: UUID?
    let chatID: String
    let onPreview: (LocalImage)->Void
    @State private var photos: [PhotosPickerItem] = []
    @State private var importing = false
    @State private var options = false
    @State private var imageConnections: [LLMConnection] = []
    private var loading: Bool { importID != nil }
    @State private var gallery = false
    @State private var loadTask: Task<Void, Never>?
    var body: some View {
        VStack(spacing:8) {
            if !plan.references.isEmpty {
                ScrollView(.horizontal) {
                    HStack(spacing:10) {
                        ForEach(plan.references) { ref in
                            if let image = store.imageLibrary.index.assets[ref.id] {
                                VStack(spacing:4) {
                                    Button { onPreview(image) } label: { LocalImageThumbnail(image:image,library:store.imageLibrary).frame(width:72,height:60) }.accessibilityLabel("预览参考图")
                                    Menu { ForEach(ImageReference.roles,id:\.self) { role in Button(LocalizedStringKey(ImageReference.title(role))) { if let i=plan.references.firstIndex(where:{$0.id==ref.id}) { plan.references[i].role=role } } } } label: { Text(LocalizedStringKey(ImageReference.title(ref.role))).font(.caption2) }
                                }.padding(8).background(meloGold.opacity(0.07),in:RoundedRectangle(cornerRadius:12))
                                .overlay(alignment:.topTrailing) { Button { plan.references.removeAll{$0.id==ref.id} } label:{ Image(systemName:"xmark.circle.fill").font(.system(size:18)).padding(4) }.accessibilityLabel("移除参考图") }
                            }
                        }
                    }.padding(.trailing,4)
                }.frame(height:100)
            }
            HStack(spacing:14) {
                PhotosPicker(selection:$photos,maxSelectionCount:ImageTaskPlan.maxReferences,matching:.images,photoLibrary:.shared()) { Label("照片",systemImage:"photo.on.rectangle").font(.caption) }.disabled(loading || store.isSending(chatID))
                Button { importing=true } label:{ Image(systemName:"folder").frame(minWidth:32,minHeight:32) }.accessibilityLabel("从文件选择图片").disabled(loading || store.isSending(chatID))
                Menu {
                    Button("本机图片库") { gallery=true };Button("图片模型与尺寸") {
                        do { imageConnections = try LLMConnection.saved().filter { !$0.key.isEmpty && $0.apiProtocol != "anthropic" }; options=true }
                        catch { store.error="模型连接无法读取，请先在系统设置中检查连接。" }
                    }
                } label: { Label("图片选项",systemImage:"ellipsis").font(.caption) }.disabled(loading || store.isSending(chatID))
                Spacer(minLength:0)
                if loading { ProgressView().controlSize(.small) }
            }.foregroundStyle(meloGold)
        }
        .onChange(of:photos) { _,items in
            guard !items.isEmpty else { return }; let target=chatID; let token=UUID()
            loadTask?.cancel()
            importID=token
            loadTask = Task { @MainActor in
                defer{if importID==token{importID=nil};photos=[]}
                do {
                    var refs:[ImageReference]=[]
                    for item in items {
                        guard let data=try await item.loadTransferable(type:Data.self) else { throw MeloError.message("无法载入相册图片，请下载原图后重试。") }
                        try Task.checkCancellation();guard chatID==target else{return}
                        let image=try store.importImage(data);refs.append(ImageReference(id:image.id))
                    }
                    guard chatID==target else{return};plan.references=refs
                } catch is CancellationError {} catch { store.error=error.localizedDescription }
            }
        }
        .onDisappear { loadTask?.cancel() }
        .fileImporter(isPresented:$importing,allowedContentTypes:[.image],allowsMultipleSelection:true) { result in
            do {
                let urls=try result.get();guard urls.count<=ImageTaskPlan.maxReferences else{throw MeloError.message("一次最多选择八张图片。")}
                let refs=try urls.map { url -> ImageReference in
                    let access=url.startAccessingSecurityScopedResource();defer{if access{url.stopAccessingSecurityScopedResource()}}
                    guard (try url.resourceValues(forKeys:[.fileSizeKey]).fileSize ?? Int.max)<=24*1024*1024 else{throw MeloError.message("单张图片不能超过 24 MB。")}
                    return ImageReference(id:try store.importImage(Data(contentsOf:url)).id)
                };plan.references=refs
            } catch { store.error=error.localizedDescription }
        }
        .sheet(isPresented:$gallery) { ImageGallery { image in plan.references=[ImageReference(id:image.id)]; plan.action = .auto } }
        .sheet(isPresented:$options) {
            NavigationStack {
                Form {
                    Section("图片连接") {
                        Picker("生成与编辑使用", selection: Binding(get: { plan.connectionID ?? "" }, set: { plan.connectionID = $0 })) {
                            Text("沿用本对话连接").tag("")
                            Text("Codex（ChatGPT 账号）").tag("chatgpt")
                            ForEach(imageConnections) { connection in Text(connection.name).tag(connection.id) }
                            if let id = plan.connectionID, !id.isEmpty, id != "chatgpt", !imageConnections.contains(where: { $0.id == id }) { Text("原连接不可用，请重新选择").tag(id) }
                        }
                        Text("Codex 登录可用于聊天、看图和图片生成 / 编辑；图像任务也可单独选择 API 连接，不改变本对话的聊天模型。")
                            .font(.footnote).foregroundStyle(.secondary)
                        NavigationLink("Codex 登录与账号") { ScrollView { CodexLoginCard().padding(20) }.navigationTitle("Codex 登录") }
                    }
                    Section("图片任务") {
                        TextField("API 图片模型",text:$plan.model).textInputAutocapitalization(.never).autocorrectionDisabled()
                        Text("Codex 使用服务分配的图片引擎，实际返回型号记录在任务空间；尺寸和质量按选择请求，以实际输出为准。API 连接使用此处填写的图片型号。").font(.footnote).foregroundStyle(.secondary)
                        Picker("尺寸",selection:$plan.size) { ForEach(ImageTaskPlan.sizes, id: \.id) { Text(LocalizedStringKey($0.label)).tag($0.id) } }
                        Text("2K、4K 更慢、用量更高；4K 为实验尺寸，效果可能不稳定。若通道不接受所选尺寸，会按服务默认尺寸生成并注明实际像素。").font(.footnote).foregroundStyle(.secondary)
                        Picker("质量",selection:$plan.quality) { Text("自动").tag("auto");Text("低").tag("low");Text("中").tag("medium");Text("高").tag("high") }
                    }
                    Section { Text("Codex 使用订阅额度；API 连接按对应平台计费，需支持 images/edits 和所选图片模型。失败时不自动切换通道。看图分析仍使用聊天模型。一次最多八张图片；多张图片默认逐张修改，说明“合成”时合成一张。") }
                }.navigationTitle("图片设置").toolbar { ToolbarItem(placement:.confirmationAction){Button("完成"){options=false}} }
            }.preferredColorScheme(.dark)
        }
    }
}
struct MessageImages: View {
    @EnvironmentObject var store: ChatStore
    let messageID: String
    let preview: (LocalImage)->Void
    let edit: (LocalImage)->Void
    var body: some View {
        let images=store.imageLibrary.images(for:messageID)
        if !images.isEmpty {
            VStack(alignment:.leading,spacing:8) {
                ForEach(images) { image in
                    Button { preview(image) } label: { LocalImageThumbnail(image:image,library:store.imageLibrary).frame(maxWidth:.infinity).frame(height:210).background(.black.opacity(0.2),in:RoundedRectangle(cornerRadius:14)) }.accessibilityLabel("打开图片预览")
                    HStack { Text("\(image.width) × \(image.height)").font(.caption2).foregroundStyle(.secondary);Spacer();Button("继续修改"){edit(image)}.font(.caption) }
                }
            }
        }
    }
}
struct ImagePreview: View {
    @EnvironmentObject var store: ChatStore
    @Environment(\.dismiss) private var dismiss
    @State var image: LocalImage
    let onUse: (LocalImage)->Void
    var chatID: String? = nil
    @State private var reviewing=false
    @State private var showOriginal=false
    @State private var status=""
    @State private var busy=false
    @State private var recognized=""
    @State private var previewBitmap: UIImage?
    private var original: LocalImage? { image.referenceIDs.first.flatMap{store.imageLibrary.index.assets[$0]} }
    private var displayed: LocalImage { showOriginal ? (original ?? image) : image }
    var body: some View {
        NavigationStack {
            VStack(spacing:14) {
                if original != nil { Picker("图片对照",selection:$showOriginal) { Text("结果").tag(false);Text("原图").tag(true) }.pickerStyle(.segmented).padding(.horizontal).disabled(busy) }
                Group {
                    if let previewBitmap {
                        ImageZoomView(image: previewBitmap, imageID: displayed.id)
                    } else { ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity) }
                }
                // Fixed share of the screen, not "whatever is left": the result and
                // original pages then place the image at exactly the same height.
                .frame(maxWidth:.infinity).containerRelativeFrame(.vertical) { length, _ in max(180, length * 0.58) }.clipped()
                ScrollView { VStack(spacing:14) {
                VStack(spacing:2) {
                    Text("\(displayed.width) × \(displayed.height)").font(.caption).foregroundStyle(.secondary)
                    Text("服务返回：\(displayed.reportedModel)").font(.caption2).foregroundStyle(.secondary).opacity(displayed.reportedModel.isEmpty ? 0 : 1)
                }
                ScrollView(.horizontal) {
                    HStack(spacing:18) {
                        Button("继续修改"){onUse(displayed);dismiss()}
                        Menu("本机处理") {
                            Button("旋转 90°"){transform("rotate")};Button("居中裁成正方形"){transform("square")}
                            Button("最长边 1024"){transform("1024")};Button("最长边 2048"){transform("2048")}
                            Button("转成 JPEG"){transform("jpeg")};Button("转成 PNG"){transform("png")}
                        }
                        if chatID != nil { Button("检查图片"){reviewing=true} }
                        Button("提取文字"){recognize()}
                        Button("保存到照片"){savePhoto()}
                        if let url=try? store.imageLibrary.url(displayed) { ShareLink(item:url){Label("分享 / 存文件",systemImage:"square.and.arrow.up")} }
                    }.font(.subheadline).padding(.horizontal).frame(minHeight:44)
                }.disabled(busy)
                if busy { ProgressView() }
                if !status.isEmpty { Text(status).font(.caption).foregroundStyle(meloGold).padding(.horizontal) }
                if !recognized.isEmpty { ScrollView { Text(recognized).textSelection(.enabled).frame(maxWidth:.infinity,alignment:.leading).padding() }.frame(maxHeight:140);Button("复制文字"){UIPasteboard.general.string=recognized;status="文字已复制"} }
                Text("本机处理会另存新图，原图保留。图片文件暂不参与两端同步。").font(.caption2).foregroundStyle(.secondary).padding(.horizontal)
                } }
            }.padding(.bottom,12).background(meloBackground).navigationTitle("图片").navigationBarTitleDisplayMode(.inline)
            .toolbar{ToolbarItem(placement:.confirmationAction){Button("完成"){dismiss()}}}
        }.preferredColorScheme(.dark)
        .sheet(isPresented: $reviewing) { if let chatID { ImageReviewView(image: displayed, chatID: chatID, completed: { reviewing = false; dismiss() }) } }
        .task(id:displayed.id) {
            previewBitmap=nil;recognized=""
            if status.contains("文字") { status="" }
            do { let data=try store.imageLibrary.data(displayed)
                let cg=try await Task.detached(priority:.userInitiated){try ImageLibrary.decoded(data)}.value
                try Task.checkCancellation();previewBitmap=UIImage(cgImage:cg)
            } catch { status="无法打开图片：\(error.localizedDescription)" }
        }
    }
    private func transform(_ operation:String) {
        do { image=try store.transformImage(displayed,operation:operation);showOriginal=false;status="已另存新图，可继续修改或保存" }
        catch { status=error.localizedDescription }
    }
    private func recognize() {
        let target=displayed;busy=true;status="正在本机识别文字…"
        Task { @MainActor in
            defer{busy=false}
            do {
                let bytes=try store.imageLibrary.data(target)
                recognized=try await Task.detached(priority:.userInitiated) {
                    let request=VNRecognizeTextRequest();request.recognitionLevel = .accurate;request.usesLanguageCorrection=true;request.automaticallyDetectsLanguage=true
                    try VNImageRequestHandler(data:bytes).perform([request])
                    return (request.results ?? []).compactMap{$0.topCandidates(1).first?.string}.joined(separator:"\n")
                }.value
                status=recognized.isEmpty ? "未识别到清晰文字" : "文字已识别，可长按选择或复制"
            } catch { status=error.localizedDescription }
        }
    }
    private func savePhoto() {
        let target=displayed;busy=true
        Task { @MainActor in
            defer{busy=false}
            let authorization=await PHPhotoLibrary.requestAuthorization(for:.addOnly)
            guard authorization == .authorized || authorization == .limited else{status="未允许保存照片，请在系统设置中允许 Melo 添加照片。";return}
            do {
                let data=try store.imageLibrary.data(target)
                try await PHPhotoLibrary.shared().performChanges { let request=PHAssetCreationRequest.forAsset();request.addResource(with:.photo,data:data,options:nil) }
                status="已保存到照片"
            } catch { status="保存失败：\(error.localizedDescription)" }
        }
    }
}

struct ImageGallery: View {
    @EnvironmentObject var store: ChatStore
    @Environment(\.dismiss) private var dismiss
    let onUse: (LocalImage)->Void
    @State private var preview: LocalImage?
    var body: some View {
        NavigationStack {
            ScrollView {
                let images=store.imageLibrary.index.assets.values.sorted { $0.createdAt > $1.createdAt }
                if images.isEmpty { ContentUnavailableView("还没有图片",systemImage:"photo.on.rectangle",description:Text("从对话选图或生成后，会保存在这里。")) }
                LazyVGrid(columns:[GridItem(.adaptive(minimum:130))],spacing:16) {
                    ForEach(images) { image in
                        VStack { Button { preview=image } label: { LocalImageThumbnail(image:image,library:store.imageLibrary).frame(height:140) }.accessibilityLabel("查看已保存图片")
                            Button("继续修改"){onUse(image);dismiss()}.font(.caption)
                        }.padding(8).background(meloGold.opacity(0.06),in:RoundedRectangle(cornerRadius:14))
                    }
                }.padding()
            }.background(meloBackground).navigationTitle("本机图片库")
                .toolbar { ToolbarItem(placement:.confirmationAction){Button("完成"){dismiss()}} }
                .sheet(item:$preview){ImagePreview(image:$0){onUse($0);dismiss()}}
        }.preferredColorScheme(.dark)
    }
}
