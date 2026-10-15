import Foundation
import CoreGraphics

@main struct ImageWorkflowTests {
    static func main() async throws {
        for prompt in ["生成一张海报，不要修改人物的脸。", "Generate an image of a classroom; do not draw any text.", "生成一张提示词海报"] {
            let plan = try ImageTaskPlan().resolved(prompt: prompt, previousImages: []); assert(plan.makesImage, prompt)
        }
        for prompt in ["不要生成图片", "请写生成图片的代码", "How to generate an image"] {
            let plan = try ImageTaskPlan().resolved(prompt: prompt, previousImages: []); assert(!plan.makesImage)
        }

        let inspection = ImageReviewRequest(imageID: UUID().uuidString, requirements: "检查准确文字")
        let inspectionPlan = try inspection.plan.resolved(prompt: inspection.prompt, previousImages: [])
        assert(inspectionPlan.action == .analyze && !inspectionPlan.makesImage && inspectionPlan.references.count == 1)
        assert(inspection.prompt.contains("检查准确文字") && inspection.prompt.contains("不要修改或生成"))

        func check(_ value: @autoclosure () throws -> Bool, _ message: String = "Image regression", file: StaticString = #file, line: UInt = #line) throws { let result = try value(); assert(result, message, file: file, line: line) }
        let root=FileManager.default.temporaryDirectory.appendingPathComponent("MeloImageTests-"+UUID().uuidString)
        defer{try? FileManager.default.removeItem(at:root)}
        let context=CGContext(data:nil,width:96,height:64,bitsPerComponent:8,bytesPerRow:0,space:CGColorSpaceCreateDeviceRGB(),bitmapInfo:CGImageAlphaInfo.premultipliedLast.rawValue)!
        context.setFillColor(CGColor(red:1,green:0.5,blue:0,alpha:1));context.fill(CGRect(x:0,y:0,width:96,height:64))
        let data=try ImageLibrary.encoded(context.makeImage()!)
        let library=ImageLibrary(directory:root)
        let original=try library.store(data,title:"fixture")
        let uploaded = ImageTaskPlan(references:[ImageReference(id:original.id)])
        let fixtures = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: "ios/Tests/Fixtures/image-natural-intent.json"))) as! [[String:Any]]
        for fixture in fixtures {
            let prompt = fixture["prompt"] as! String
            let attached = fixture["hasImage"] as! Bool
            let automatic = ImageTaskPlan(references: attached ? uploaded.references : [])
            let route = try automatic.resolved(prompt: prompt, previousImages: [])
            try check(route.action.rawValue == fixture["action"] as! String, "Natural request misrouted: \(prompt)")
            let request = ImageRequestBody.responses(messages:[ChatMessage(role:"user",content:prompt)],inputs:attached ? try library.inputs(route.references) : [],task:route,model:"fixture",instructions:"")
            try check((request["tools"] != nil) == route.makesImage, "First turn must include the required image tool")
        }
        for prompt in ["帮我把转盘掉漆的处理干净，背景墙换成黑色木纹，压低一点曝光", "改一下背景墙，其他保持不变", "换背景", "把后面的墙换一下", "把墙改白", "把背景墙刷成奶油色", "给背景墙加上木饰面", "把背景墙颜色调浅一点", "make the background wall white", "retouch the background"] {
            let routed = try uploaded.resolved(prompt:prompt,previousImages:[])
            try check(routed.action == .edit, "Uploaded image edit misrouted to analysis: \(prompt)")
            let request = ImageRequestBody.responses(messages:[ChatMessage(role:"user",content:prompt)],inputs:try library.inputs(routed.references),task:routed,model:"account-model",instructions:"")
            try check((request["tools"] as? [[String:String]])?.first?["action"] == "edit")
            try check((request["tool_choice"] as? [String:String])?["type"] == "image_generation")
            let blocks=(request["input"] as! [[String:Any]])[0]["content"] as! [[String:Any]]
            try check(blocks.last?["image_url"] as? String == "data:"+original.mimeType+";base64,"+(try library.data(original)).base64EncodedString(), "Edit request must carry the stored input bytes")
        }
        for prompt in ["不要换背景，只分析", "别改这张图，只讲怎么改", "换背景的教程是什么", "请写一段换背景的提示词", "这张图不用改，只分析一下背景墙", "他说“改一下背景墙”是什么意思", "不要改背景墙的颜色", "Do not change the background", "How can I change the wall color?", "这张图的背景墙有什么问题"] {
            let routed = try uploaded.resolved(prompt:prompt,previousImages:[])
            try check(!routed.makesImage, "Discussion or prohibition must not generate: \(prompt)")
            let request=ImageRequestBody.responses(messages:[ChatMessage(role:"user",content:prompt)],inputs:try library.inputs(routed.references),task:routed,model:"account-model",instructions:"")
            try check(request["tools"] == nil && request["tool_choice"] == nil)
        }
        try check(try uploaded.resolved(prompt:"不要修改人物的脸，只改一下背景墙",previousImages:[]).action == .edit)
        try check(try ImageTaskPlan(action:.analyze,references:uploaded.references).resolved(prompt:"改一下背景墙",previousImages:[]).action == .analyze)
        for action in [ImageAction.edit, .generate] {
            try ImageTaskPlan(action:action).validateRoute(useChatGPT:true,apiProtocol:"responses")
            do { try ImageTaskPlan(action:action).validateRoute(useChatGPT:false,apiProtocol:"anthropic"); fatalError("Anthropic image tool admitted") } catch {}
            try ImageTaskPlan(action:action).validateRoute(useChatGPT:false,apiProtocol:"chat-completions")
        }
        try ImageTaskPlan(action:.analyze).validateRoute(useChatGPT:true,apiProtocol:"responses")
        let legacy = Data(#"{"action":"edit","references":[],"model":"gpt-image-2","size":"auto","quality":"auto"}"#.utf8)
        try check(try JSONDecoder().decode(ImageTaskPlan.self,from:legacy).connectionID == nil)
        let selected = ImageTaskPlan(action:.edit,references:uploaded.references,connectionID:"image-api-fixture")
        try check(try JSONDecoder().decode(ImageTaskPlan.self,from:JSONEncoder().encode(selected)) == selected)
        let plan=try ImageTaskPlan(action:.edit,references:[ImageReference(id:original.id,role:"subject")]).resolved(prompt:"把橙色改成蓝色，其余不变",previousImages:[])
        try library.bind([original],to:"question",request:plan)
        let restored=ImageLibrary(directory:root)
        try check(restored.ready && restored.images(for:"question")==[original])
        try check(restored.index.requests["question"]==plan)
        let originalBytes = try restored.data(original)
        let rotated=try restored.transformed(original,operation:"rotate")
        try check(rotated.width==64 && rotated.height==96 && rotated.referenceIDs==[original.id])
        let cropped=try restored.transformed(original,operation:"square")
        try check(cropped.width==64 && cropped.height==64)
        let jpeg=try restored.transformed(original,operation:"jpeg")
        try check(jpeg.mimeType=="image/jpeg" && (try restored.data(jpeg)).starts(with:[0xff,0xd8,0xff]))
        try check(try restored.data(original)==originalBytes,"Original bytes must survive every local edit")
        var escaped=original;escaped.id="../outside"
        do{_=try restored.url(escaped);fatalError("Path traversal accepted")}catch{}
        do{_=try library.store(Data("not an image".utf8),title:"invalid");fatalError("Nonimage accepted")}catch{}
        let inputs=try restored.inputs(plan.references)
        let input=[ChatMessage(role:"user",content:"把橙色改成蓝色，其余不变")]
        let body=ImageRequestBody.responses(messages:input,inputs:inputs,task:plan,model:"account-model",instructions:"role")
        let content=((body["input"] as! [[String:Any]])[0]["content"] as! [[String:Any]])
        try check(content.count==2 && content[1]["type"] as? String=="input_image")
        try check(content[1]["image_url"] as? String==inputs[0].dataURL)
        try check((body["tools"] as! [[String:String]])[0]["action"]=="edit")
        try check((body["instructions"] as! String).contains("用户明确要求的变化优先"))
        try check((body["tools"] as! [[String:String]])[0]["model"]=="gpt-image-2")
        for anthropic in [false,true] {
            let rows=ImageRequestBody.chat(messages:input,inputs:inputs,anthropic:anthropic)
            let blocks=rows[0]["content"] as! [[String:Any]]
            try check(blocks[1]["type"] as? String==(anthropic ? "image":"image_url"))
        }
        for text in ["不要生成图片，只分析", "如何生成图片", "他说“生成图片”是什么意思", "write code to generate an image"] {
            try check(try ImageTaskPlan().resolved(prompt:text,previousImages:[original.id]).action == .analyze)
        }
        try check(try ImageTaskPlan().resolved(prompt:"生成一张图片，画一棵树",previousImages:[]).action == .generate)
        try check(try ImageTaskPlan().resolved(prompt:"把它改成蓝色",previousImages:[original.id]).references.first?.id == original.id)
        try check(try ImageTaskPlan().resolved(prompt:"这张图中有什么",previousImages:[original.id]).references.first?.id == original.id)
        do{_=try ImageTaskPlan(action:.edit).resolved(prompt:"改色",previousImages:[]);fatalError("Missing edit input accepted")}catch{}
        do{_=try ImageTaskPlan(action:.generate).resolved(prompt:String(repeating:"长",count:24001),previousImages:[]);fatalError("Long prompt silently truncated")}catch{}
        let cleanup = ImageLibrary(directory: root.appendingPathComponent("cleanup"))
        let exclusive = try cleanup.store(data, title: "exclusive"), shared = try cleanup.store(data, title: "shared")
        let draftImage = try cleanup.store(data, title: "draft"), ancestor = try cleanup.store(data, title: "ancestor")
        let descendant = try cleanup.store(data, title: "descendant", references: [ancestor.id])
        try cleanup.bind([exclusive, shared, draftImage, ancestor], to: "removed")
        try cleanup.bind([shared, descendant], to: "kept")
        try cleanup.removeMessages(["removed"], protecting: [draftImage.id])
        assert(cleanup.images(for: "removed").isEmpty && cleanup.index.assets[exclusive.id] == nil)
        try check(!FileManager.default.fileExists(atPath: try cleanup.url(exclusive).path))
        for image in [shared, draftImage, ancestor, descendant] { try check(!(try cleanup.data(image)).isEmpty) }
        let reloaded = ImageLibrary(directory: cleanup.directory)
        assert(reloaded.index.assets[exclusive.id] == nil && reloaded.images(for: "kept").count == 2)
        try reloaded.removeMessages(["removed"], protecting: [draftImage.id]) // crash/retry is idempotent
        let encoded=data.base64EncodedString()
        let item:[String:Any]=["id":"image-1","type":"image_generation_call","status":"completed","result":encoded,"model":"reported-image-model","revised_prompt":"fixture"]
        func wire(_ object:[String:Any]) throws -> Data { Data(("data: "+String(data:try JSONSerialization.data(withJSONObject:object),encoding:.utf8)!+"\r\n\r\n").utf8) }
        var stream=ChatGPTSSE(maxBytes:64*1024*1024)
        for byte in try wire(["type":"response.output_item.done","item":item]) {try stream.accept(byte)}
        do{_=try stream.finish();fatalError("Tool completion must not substitute response completion")}catch{}
        try check(stream.stream.images.isEmpty)
        for byte in try wire(["type":"response.completed","response":["status":"completed","model":"language-model","output":[item]]]) {try stream.accept(byte)}
        try check(try stream.finish()=="图片已生成。")
        try check(stream.stream.images.count==1 && stream.stream.images[0].data==data && stream.stream.images[0].reportedModel=="reported-image-model")
        try check(stream.stream.observation.pipeline.contains{$0.id=="image:generate" && $0.status=="completed"})
        for status in ["failed","incomplete"] {
            var broken=ChatGPTSSE();do{for byte in try wire(["type":"response.\(status)","response":["status":status]]){try broken.accept(byte)};fatalError("Incomplete accepted")}catch{}
        }
        var invalid=ChatGPTStream()
        do{try invalid.accept(String(data:try JSONSerialization.data(withJSONObject:["type":"response.completed","response":["status":"completed","output":[["type":"image_generation_call","status":"completed","result":"bad"]]]]),encoding:.utf8)!);fatalError("Bad image accepted")}catch{}
        var limited=ChatGPTSSE(maxBytes:10)
        do{for byte in Data(repeating:65,count:11){try limited.accept(byte)};fatalError("Unbounded SSE accepted")}catch{}
        try check(try ImageNetwork.endpoint(from:"https://example.invalid/v1/chat/completions",editing:true).path=="/v1/images/edits")
        let (multipart,type)=try ImageNetwork.payload(prompt:"change color",task:plan,inputs:inputs,boundary:"test-boundary")
        try check(type.contains("multipart/form-data") && multipart.range(of:inputs[0].data) != nil)
        let header=String(decoding:multipart,as:UTF8.self)
        try check(header.contains("name=\"image[]\"") && header.contains("--test-boundary--"))
        let (json,_) = try ImageNetwork.payload(prompt:"Generate",task:ImageTaskPlan(action:.generate),inputs:[],boundary:"unused")
        try check((try JSONSerialization.jsonObject(with:json) as! [String:Any])["n"] as? Int==1)
        let config=URLSessionConfiguration.ephemeral;config.protocolClasses=[ImageHTTPFixture.self]
        let session=URLSession(configuration:config);defer{session.invalidateAndCancel()}
        ImageHTTPFixture.payload=try JSONSerialization.data(withJSONObject:["model":"image-provider-model","data":[["b64_json":encoded]]])
        let generated=try await ImageNetwork.reply(prompt:"Generate an image",task:ImageTaskPlan(action:.generate),inputs:[],endpoint:"https://fixture.invalid/v1/chat/completions",token:"fixture-key",session:session)
        try check(generated.images.count==1 && generated.images[0].reportedModel=="image-provider-model")
        ImageHTTPFixture.expectedPath="/v1/images/edits"
        ImageHTTPFixture.expectedInput=inputs[0].data
        let edited=try await ImageNetwork.reply(prompt:"背景墙换成黑色木纹，压低一点曝光",task:plan,inputs:inputs,endpoint:"https://fixture.invalid/v1/chat/completions",token:"fixture-key",session:session)
        try check(edited.images.first?.data == data && ImageHTTPFixture.calls==2)
        ImageHTTPFixture.expectedPath="/v1/images/generations"; ImageHTTPFixture.expectedInput=nil
        ImageHTTPFixture.status=403
        do{_=try await ImageNetwork.reply(prompt:"Generate",task:ImageTaskPlan(action:.generate),inputs:[],endpoint:"https://fixture.invalid/v1/chat/completions",token:"fixture-key",session:session);fatalError("Unauthorized image response accepted")}catch{}
        try check(ImageHTTPFixture.calls==3,"A failed image request must not silently retry")
        ImageHTTPFixture.status=400
        ImageHTTPFixture.payload=Data(#"{"error":{"code":"unsupported_tool","param":"tools[0].type","message":"private prompt and sk-fixture-secret"}}"#.utf8)
        do { _=try await ImageNetwork.reply(prompt:"Generate",task:ImageTaskPlan(action:.generate),inputs:[],endpoint:"https://fixture.invalid/v1",token:"fixture-key",session:session);fatalError("HTTP 400 accepted") }
        catch { try check(error.localizedDescription.contains("unsupported_tool") && !error.localizedDescription.contains("private prompt") && !error.localizedDescription.contains("sk-fixture")) }
        try check(ImageHTTPFixture.calls==4,"Rejection must not cause an automatic retry")
        var failedStream=ChatGPTStream()
        do { try failedStream.accept(#"{"type":"response.failed","response":{"error":{"code":"unsupported_tool","param":"tools[0].type"}}}"#); fatalError("failed stream accepted") }
        catch { try check(error.localizedDescription.contains("unsupported_tool")) }
        // A damaged image index must not disable ordinary text chat.
        try Data("broken".utf8).write(to:root.appendingPathComponent("index.json"))
        let broken=ImageLibrary(directory:root);try check(!broken.ready && (try broken.inputs([])).isEmpty)
        do{_=try broken.inputs(plan.references);fatalError("Corrupt index accepted for images")}catch{}
        try check(try ImageTaskPlan(model: "").resolved(prompt: "你好", previousImages: []).action == .analyze, "invalid image model must not block text chat")
        do { _ = try ImageTaskPlan(action:.edit,references:[ImageReference(id:original.id)]).resolved(prompt:"  ",previousImages:[]);fatalError("Empty edit accepted") } catch {}
        let newFromStyle = ImageTaskPlan(action:.generate,references:[ImageReference(id:original.id,role:"style")]).annotatedPrompt("生成一张写着 MELO 的新海报")
        try check(newFromStyle.contains("不锁定第一张图的构图") && newFromStyle.contains("不复制无关主体或文字") && newFromStyle.contains("MELO"), "generation references must not inherit edit preservation")
        let directoryStyle = ImageLibrary(directory: URL(fileURLWithPath: root.appendingPathComponent("DirectoryStyle").path, isDirectory: true))
        let directoryAsset = try directoryStyle.store(data, title: "Directory URL regression")
        try check(!directoryStyle.data(directoryAsset).isEmpty, "directory URL flags must not reject sandbox images")
        print("Image workflow passed: persisted originals/references, safe formats/paths, local transforms, provider payloads, explicit intent, complete image SSE and failure boundaries")
    }
}

final class ImageHTTPFixture: URLProtocol {
    static var payload=Data()
    static var status=200
    static var calls=0
    static var expectedPath="/v1/images/generations"
    static var expectedInput: Data?
    override class func canInit(with request: URLRequest)->Bool{true}
    override class func canonicalRequest(for request: URLRequest)->URLRequest{request}
    override func startLoading(){
        Self.calls += 1
        assert(request.url?.path==Self.expectedPath && request.httpMethod=="POST")
        assert(request.value(forHTTPHeaderField:"Authorization")=="Bearer fixture-key")
        if let input=Self.expectedInput {
            var body=request.httpBody ?? Data()
            if let stream=request.httpBodyStream {
                stream.open();defer{stream.close()};var buffer=[UInt8](repeating:0,count:8192)
                while stream.hasBytesAvailable { let count=stream.read(&buffer,maxLength:buffer.count);if count<=0{break};body.append(contentsOf:buffer.prefix(count)) }
            }
            assert(request.value(forHTTPHeaderField:"Content-Type")?.contains("multipart/form-data")==true)
            assert(body.range(of:input) != nil && String(decoding:body,as:UTF8.self).contains("gpt-image-2"))
        }
        let response=HTTPURLResponse(url:request.url!,statusCode:Self.status,httpVersion:"HTTP/1.1",headerFields:["Content-Type":"application/json"])!
        client?.urlProtocol(self,didReceive:response,cacheStoragePolicy:.notAllowed)
        client?.urlProtocol(self,didLoad:Self.payload);client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading(){}
}
