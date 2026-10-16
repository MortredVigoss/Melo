#if DEBUG && targetEnvironment(simulator)
import UIKit

@MainActor enum ImageWorkflowVerification {
    static var running=false
    static func fixture(_ blue: Bool) throws -> Data {
        let format=UIGraphicsImageRendererFormat();format.scale=1
        return UIGraphicsImageRenderer(size:CGSize(width:640,height:420),format:format).pngData { context in
            UIColor(white:0.035,alpha:1).setFill();context.fill(CGRect(x:0,y:0,width:640,height:420))
            (blue ? UIColor.systemBlue : UIColor.systemOrange).setFill();context.cgContext.fillEllipse(in:CGRect(x:220,y:80,width:200,height:200))
            let attrs:[NSAttributedString.Key:Any]=[.font:UIFont.systemFont(ofSize:30,weight:.medium),.foregroundColor:UIColor.white]
            "MELO IMAGE QA".draw(at:CGPoint(x:180,y:315),withAttributes:attrs)
        }
    }
    static func run() async {
        guard !running else{return};running=true
        let parent=FileManager.default.urls(for:.applicationSupportDirectory,in:.userDomainMask)[0]
        let root=parent.appendingPathComponent("ImageVerification-"+UUID().uuidString)
        var result:[String:Any]=["passed":false,"realProvider":false]
        do {
            let orange=try fixture(false),blue=try fixture(true)
            // An unsigned-in Codex phone must stop before creating a failed request, preserving its draft.
            let blocked=ChatStore(directory:root.appendingPathComponent("blocked"))
            let blockedChat=blocked.newChat()!,blockedInput=try blocked.importImage(orange)
            _ = blocked.updatePreferences { p in
                if p.chatModels == nil { p.chatModels = [:] }
                p.chatModels?[blockedChat] = ConversationModel(connectionID:"chatgpt",model:"gpt-6-astra")
            }
            let requirement="改一下背景墙，换成黑色木纹，压低一点曝光"
            let blockedPlan=ImageTaskPlan(references:[ImageReference(id:blockedInput.id)])
            blocked.composerDrafts[blockedChat] = ConversationDraft(text:requirement,imagePlan:blockedPlan)
            blocked.send(requirement,chatID:blockedChat,imageTask:blockedPlan)
            guard blocked.error?.contains(CodexOAuth.loginRequired)==true,!blocked.anySending,blocked.chats.first?.messages.isEmpty==true,blocked.executionRecords.isEmpty,
                  blocked.composerDrafts[blockedChat]?.text==requirement,blocked.composerDrafts[blockedChat]?.imagePlan==blockedPlan else {throw MeloError.message("Unsigned Codex route did not preserve input at preflight")}
            do { _=try await blocked.account.reply(messages:[ChatMessage(role:"user",content:requirement)],model:"gpt-6-astra",instructions:"",imageTask:ImageTaskPlan(action:.edit,references:blockedPlan.references));throw MeloError.message("Unsigned direct account route admitted") }
            catch { guard error.localizedDescription==CodexOAuth.loginRequired else {throw error} }
            let connection=LLMConnection(id:"image-test",name:"Image test",baseURL:"https://fixture.invalid/v1",model:"",key:"fixture-only")
            var calls=0
            let store=ChatStore(directory:root,replyLoader:{ history, _ in
                calls += 1
                guard history.last?.role == "user" else{throw MeloError.message("missing question")}
                if calls==1 { throw URLError(.networkConnectionLost) }
                return ModelReply(text:"测试夹具图片，非真实模型结果",images:[ImagePayload(data:blue,mimeType:"image/png",reportedModel:"fixture-only")])
            },loadConnections:{[connection]})
            let chat=store.newChat()!,input=try store.importImage(orange)
            store.send("",chatID:chat,imageTask:ImageTaskPlan(action:.edit,references:[ImageReference(id:input.id)]))
            guard store.chats.first?.messages.isEmpty==true,calls==0 else{throw MeloError.message("空编辑要求触发了生成")}
            store.send("改一下背景墙，换成蓝色",chatID:chat,imageTask:ImageTaskPlan(references:[ImageReference(id:input.id)]))
            try await Task.sleep(for:.milliseconds(160))
            guard store.chats.first?.messages.count==1,!store.anySending,let user=store.chats.first?.messages.first,store.imageLibrary.images(for:user.id).count==1 else{throw MeloError.message("失败丢失参考图或问题")}
            guard store.imageLibrary.index.requests[user.id]?.action == .edit,
                  store.executionRecords.last?.pipeline?.contains(where: { $0.id == "reply:failure" && !$0.output.isEmpty }) == true else {throw MeloError.message("Automatic edit or failure diagnostic was not saved")}
            store.send("",chatID:chat,retry:true,imageTask:ImageTaskPlan(connectionID:connection.id))
            try await Task.sleep(for:.milliseconds(300))
            guard calls==2,store.chats.first?.messages.count==2,let answer=store.chats.first?.messages.last,
                  let output=store.imageLibrary.images(for:answer.id).first,output.referenceIDs==[input.id],output.reportedModel=="fixture-only" else{throw MeloError.message("重试重复问题或没有保存图片关联")}
            let restored=ChatStore(directory:root)
            guard restored.imageLibrary.images(for:answer.id)==[output],restored.imageLibrary.index.requests[user.id]?.references.first?.id==input.id,restored.imageLibrary.index.requests[user.id]?.connectionID==connection.id,restored.executionRecords.last?.requestedModel=="gpt-image-2" else{throw MeloError.message("图片重启恢复失败")}
            let second=restored.newChat()!
            restored.send("把它改蓝",chatID:second,imageTask:ImageTaskPlan(action:.edit))
            guard restored.chats.first(where:{$0.id==second})?.messages.isEmpty==true,!restored.anySending else{throw MeloError.message("串用其他对话图片")}
            var naturalCalls = 0
            let natural = ChatStore(directory:root.appendingPathComponent("natural"),replyLoader:{ _, instructions in
                naturalCalls += 1
                return ModelReply(text:"Fixture",images:[ImagePayload(data:blue,mimeType:"image/png")])
            })
            let naturalChat = natural.newChat()!, naturalInput = try natural.importImage(orange)
            natural.send("增加一些对比度 粉色更粉 蓝色更蓝一点点",chatID:naturalChat,imageTask:ImageTaskPlan(references:[ImageReference(id:naturalInput.id)]))
            for _ in 0..<100 { if !natural.anySending { break }; try await Task.sleep(for:.milliseconds(20)) }
            guard naturalCalls == 1, let naturalAnswer = natural.chats.first?.messages.last,
                  naturalAnswer.role == "assistant", natural.imageLibrary.images(for:naturalAnswer.id).count == 1,
                  natural.imageLibrary.index.requests[natural.chats.first!.messages.first!.id]?.action == .edit else { throw MeloError.message("Natural edit needed a second request") }
            let zoom = ImageZoomScrollView()
            zoom.frame = CGRect(x:0,y:0,width:390,height:500)
            let bitmap = UIImage(data:orange)!
            zoom.display(bitmap,id:"first");zoom.layoutIfNeeded()
            zoom.setZoomScale(1.7,animated:false);zoom.layoutIfNeeded()
            zoom.display(bitmap,id:"first");zoom.layoutIfNeeded()
            guard abs(zoom.zoomScale - 1.7) < 0.001 else { throw MeloError.message("View update reset zoom") }
            zoom.setZoomScale(zoom.zoomScale * 1.4,animated:false);zoom.layoutIfNeeded()
            guard abs(zoom.zoomScale - 2.38) < 0.001,zoom.bouncesZoom,zoom.maximumZoomScale == 4,
                  zoom.contentSize.width > zoom.bounds.width else {throw MeloError.message("Zoom must accumulate with elastic limits and pannable content")}
            zoom.contentOffset.x += 30
            let panned = zoom.contentOffset.x
            zoom.layoutIfNeeded()
            guard abs(zoom.contentOffset.x - panned) < 0.01, zoom.isScrollEnabled else { throw MeloError.message("Layout reset the image pan") }
            zoom.frame.size = CGSize(width:500,height:390);zoom.layoutIfNeeded()
            guard abs(zoom.zoomScale - 2.38) < 0.001 else {throw MeloError.message("Resize reset zoom")}
            zoom.display(bitmap,id:"second");zoom.layoutIfNeeded()
            guard zoom.zoomScale == 1 else {throw MeloError.message("New image did not reset fit")}
            result=["passed":true,"realProvider":false,"naturalEditFirstRequest":true,"nativeCumulativeZoom":true,"nativeElasticLimit":true,"zoomSurvivesViewUpdate":true,"requests":calls,"messagesAfterRetry":2,"referencePersisted":true,"outputPersisted":true,"restartRestored":true,"crossChatRejected":true,"emptyEditRejected":true,"unsignedCodexRejectedBeforeSend":true,"draftRetained":true,"automaticEditResolved":true,"failureRecorded":true,"retryConnectionPersisted":true]
        } catch {result["error"]=error.localizedDescription}
        try? FileManager.default.createDirectory(at:parent,withIntermediateDirectories:true)
        if let data=try? JSONSerialization.data(withJSONObject:result,options:[.sortedKeys,.prettyPrinted]) {try? data.write(to:parent.appendingPathComponent("image-verification.json"),options:.atomic)}
    }
    static func seedPreview(_ store: ChatStore) {
        guard store.chats.isEmpty else{return}
        do {
            let chat=store.newChat()!,orange=try store.importImage(fixture(false),title:"测试原图"),blue=try store.imageLibrary.store(fixture(true),title:"测试结果",references:[orange.id],reportedModel:"fixture-only")
            let question=ChatMessage(role:"user",content:"把中间的橙色圆形改成蓝色，其他内容保留。"),reply=ChatMessage(role:"assistant",content:"图片界面测试 · 以下为本机绘制的测试夹具，不是真实模型生成结果。")
            try store.imageLibrary.bind([orange],to:question.id,request:ImageTaskPlan(action:.edit,references:[ImageReference(id:orange.id)]))
            try store.imageLibrary.bind([blue],to:reply.id)
            let index=store.chats.firstIndex{$0.id==chat}!
            store.chats[index].title="图片处理验收";store.chats[index].messages=[question,reply];try store.save()
        } catch {store.error=error.localizedDescription}
    }
}
#endif
