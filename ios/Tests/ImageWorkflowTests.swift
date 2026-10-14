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
        ImageHTTPFixture.status=403
        do{_=try await ImageNetwork.reply(prompt:"Generate",task:ImageTaskPlan(action:.generate),inputs:[],endpoint:"https://fixture.invalid/v1/chat/completions",token:"fixture-key",session:session);fatalError("Unauthorized image response accepted")}catch{}
        try check(ImageHTTPFixture.calls==2,"A failed image request must not silently retry")
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
    override class func canInit(with request: URLRequest)->Bool{true}
    override class func canonicalRequest(for request: URLRequest)->URLRequest{request}
    override func startLoading(){
        Self.calls += 1
        assert(request.url?.path=="/v1/images/generations" && request.httpMethod=="POST")
        assert(request.value(forHTTPHeaderField:"Authorization")=="Bearer fixture-key")
        let response=HTTPURLResponse(url:request.url!,statusCode:Self.status,httpVersion:"HTTP/1.1",headerFields:["Content-Type":"application/json"])!
        client?.urlProtocol(self,didReceive:response,cacheStoragePolicy:.notAllowed)
        client?.urlProtocol(self,didLoad:Self.payload);client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading(){}
}
