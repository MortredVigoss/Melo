import Foundation

enum ImageNetwork {
    static func endpoint(from chatEndpoint: String, editing: Bool) throws -> URL {
        let url = try Network.endpoint(chatEndpoint)
        var parts = URLComponents(url: url, resolvingAgainstBaseURL: false)!
        guard parts.query == nil else { throw MeloError.message("图像 API 地址不能包含查询参数，请使用模型连接的标准地址。") }
        for suffix in ["/chat/completions", "/responses", "/images/generations", "/images/edits"] where parts.path.hasSuffix(suffix) {
            parts.path = String(parts.path.dropLast(suffix.count)); break
        }
        parts.path = parts.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        parts.path = "/" + (parts.path.isEmpty ? "v1" : parts.path) + (editing ? "/images/edits" : "/images/generations")
        return try Network.endpoint(parts.url!.absoluteString)
    }
    static func payload(prompt: String, task: ImageTaskPlan, inputs: [ImageInput], boundary: String) throws -> (Data, String) {
        let values = ["model":task.model,"prompt":task.annotatedPrompt(prompt),"size":task.size,"quality":task.quality]
        if inputs.isEmpty { return (try JSONSerialization.data(withJSONObject: (values as [String:Any]).merging(["n":1]) { $1 }), "application/json") }
        var data = Data()
        func append(_ value: String) { data.append(Data(value.utf8)) }
        for key in values.keys.sorted() { append("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(key)\"\r\n\r\n\(values[key]!)\r\n") }
        append("--\(boundary)\r\nContent-Disposition: form-data; name=\"n\"\r\n\r\n1\r\n")
        for (i,image) in inputs.enumerated() {
            append("--\(boundary)\r\nContent-Disposition: form-data; name=\"image[]\"; filename=\"reference-\(i).\(image.mimeType == "image/jpeg" ? "jpg" : "png")\"\r\nContent-Type: \(image.mimeType)\r\n\r\n")
            data.append(image.data);append("\r\n")
        }
        append("--\(boundary)--\r\n")
        return (data,"multipart/form-data; boundary=\(boundary)")
    }
    static func reply(prompt: String, task: ImageTaskPlan, inputs: [ImageInput], endpoint: String, token: String, session: URLSession = Network.session, onObservation: ((ExecutionObservation)->Void)? = nil) async throws -> ModelReply {
        let url = try self.endpoint(from:endpoint,editing:!inputs.isEmpty)
        let (body,type) = try payload(prompt:prompt,task:task,inputs:inputs,boundary:"Melo-"+UUID().uuidString)
        var observation = ExecutionObservation()
        observation.stage("image:generate",name:task.action.title,status:"running",output:"等待图片服务返回",model:task.model);onObservation?(observation)
        do {
            let data = try await Network.post(url,token:token,body:body,session:session,headers:["Content-Type":type],maxBytes:48*1024*1024,timeout:180)
            guard let object = try JSONSerialization.jsonObject(with:data) as? [String:Any], let rows = object["data"] as? [[String:Any]], !rows.isEmpty, rows.count <= 4 else { throw MeloError.message("图像服务没有返回完整图片。") }
            let images = try rows.map { try ImagePayload.decode(base64:$0["b64_json"] as? String,model:object["model"] as? String ?? "",prompt:$0["revised_prompt"] as? String ?? "") }
            try Task.checkCancellation()
            observation.returnedModel = object["model"] as? String
            observation.stage("image:generate",name:task.action.title,status:"completed",output:"已收到 \(images.count) 张完整图片",model:task.model);onObservation?(observation)
            return ModelReply(text:task.action == .edit ? "图片已修改。" : "图片已生成。",images:images)
        } catch {
            observation.stage("image:generate",name:task.action.title,status:(error is CancellationError || (error as? URLError)?.code == .cancelled) ? "cancelled" : "failed",output:String(error.localizedDescription.prefix(1000)));onObservation?(observation);throw error
        }
    }
}
extension ImagePayload {
    static func decode(base64: String?, model: String = "", prompt: String = "") throws -> ImagePayload {
        guard let base64, base64.utf8.count <= 32*1024*1024, let data = Data(base64Encoded:base64), !data.isEmpty else { throw MeloError.message("图像结果不完整或超过容量限制，未保存为成品。") }
        _ = try ImageLibrary.decoded(data)
        let mime: String
        if data.starts(with:[0x89,0x50,0x4E,0x47]) { mime="image/png" }
        else if data.starts(with:[0xFF,0xD8,0xFF]) { mime="image/jpeg" }
        else if String(data:data.prefix(4),encoding:.ascii) == "RIFF" { mime="image/webp" }
        else { throw MeloError.message("服务未返回受支持的真实图片。") }
        return ImagePayload(data:data,mimeType:mime,reportedModel:model,revisedPrompt:prompt)
    }
}
