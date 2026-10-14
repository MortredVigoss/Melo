import Foundation
import CryptoKit

// Codex public-client device authorization, matching openai/codex login/src.
// This is separate from SIWC dynamic registration; never reuse its tokens.
struct CodexRegistration: Codable, Identifiable {
    var id: String { subject + ":" + accountID }
    var subject: String
    var accountID: String
    var email: String
    var accessToken: String
    var refreshToken: String
    var idToken: String
    var expiresAt: Date
}
struct CodexDeviceCode {
    let id: String
    let userCode: String
    let interval: Double
    let expiresAt: Date
}
struct CodexToken: Decodable {
    let access_token: String
    let refresh_token: String?
    let id_token: String?
    let expires_in: Double?
    let token_type: String?
}
// Credential requests must not follow redirects or persist cookies/cache.
final class CodexNoRedirect: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}
enum CodexOAuth {
    static let clientID = "app_EMoamEEZ73f0CkXaXp7hrann"
    static let issuer = "https://auth.openai.com"
    static let resource = "https://chatgpt.com/backend-api/codex"
    static let verificationURL = URL(string: issuer + "/codex/device")!
    static let loginRequired = "请到系统设置点「使用 ChatGPT 账号登录 Codex」完成手机授权。原图和要求已保留。"
    static let session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.httpCookieStorage = nil; config.urlCache = nil
        config.timeoutIntervalForRequest = 45; config.timeoutIntervalForResource = 240
        return URLSession(configuration: config, delegate: CodexNoRedirect(), delegateQueue: nil)
    }()
    static func data(_ request: URLRequest, session: URLSession = session, limit: Int = 256_000) async throws -> (Data, Int) {
        let (bytes, response) = try await session.bytes(for: request)
        guard let http = response as? HTTPURLResponse else { throw MeloError.message("官方服务没有响应，请检查网络。") }
        var body = Data()
        for try await byte in bytes {
            try Task.checkCancellation()
            guard body.count < limit else { throw MeloError.message("官方服务响应超过容量限制。") }
            body.append(byte)
        }
        return (body, http.statusCode)
    }
    private static func post(_ path: String, _ values: [String: String], form: Bool = false, session: URLSession) async throws -> (Data, Int) {
        var request = URLRequest(url: URL(string: issuer + path)!); request.httpMethod = "POST"; request.timeoutInterval = 30
        request.setValue(form ? "application/x-www-form-urlencoded" : "application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = form ? ChatGPTProtocol.form(values) : try JSONSerialization.data(withJSONObject: values)
        return try await data(request, session: session)
    }
    static func begin(session: URLSession = session, now: Date = Date()) async throws -> CodexDeviceCode {
        let (body, status) = try await post("/api/accounts/deviceauth/usercode", ["client_id":clientID], session:session)
        guard status == 200 else { throw MeloError.message("无法申请 Codex 验证码（\(status)）。请在 ChatGPT 安全设置或工作区权限中开启设备码登录，再重试。") }
        guard let value = try JSONSerialization.jsonObject(with:body) as? [String:Any],
              let id = value["device_auth_id"] as? String, !id.isEmpty, id.count <= 512,
              let code = (value["user_code"] ?? value["usercode"]) as? String,
              code.range(of:#"^[A-Za-z0-9-]{4,32}$"#,options:.regularExpression) != nil else { throw MeloError.message("官方验证码格式无效，请重新登录。") }
        let interval = Double(value["interval"] as? String ?? "") ?? (value["interval"] as? Double) ?? 5
        return .init(id:id,userCode:code,interval:interval.isFinite && interval >= 0 && interval <= 900 ? max(1,interval) : 5,expiresAt:now.addingTimeInterval(900))
    }
    static func poll(_ code: CodexDeviceCode, session: URLSession = session, now: () -> Date = Date.init, sleep: (Double) async throws -> Void = { try await Task.sleep(for:.seconds($0)) }) async throws -> CodexToken {
        while true {
            try Task.checkCancellation()
            guard now() < code.expiresAt else { throw MeloError.message("Codex 验证码已过期，请重新获取。") }
            let (body, status) = try await post("/api/accounts/deviceauth/token", ["device_auth_id":code.id,"user_code":code.userCode], session:session)
            try Task.checkCancellation()
            guard now() < code.expiresAt else { throw MeloError.message("Codex 验证码已过期，请重新获取。") }
            if status == 403 || status == 404 {
                try await sleep(min(code.interval,code.expiresAt.timeIntervalSince(now())))
                continue
            }
            guard status == 200 else { throw MeloError.message("Codex 授权未完成（\(status)）\(Network.rejectionDetail(body))，可以重新获取验证码。") }
            let values = try exchangeValues(body)
            let (token, tokenStatus) = try await post("/oauth/token",values,form:true,session:session)
            guard tokenStatus == 200 else { throw MeloError.message("Codex 授权换取令牌失败（\(tokenStatus)）\(Network.rejectionDetail(token))，请重新登录。") }
            return try JSONDecoder().decode(CodexToken.self,from:token)
        }
    }
    static func exchangeValues(_ body: Data) throws -> [String:String] {
        guard let result = try JSONSerialization.jsonObject(with:body) as? [String:Any],
              let authorization = result["authorization_code"] as? String, !authorization.isEmpty, authorization.count < 8192,
              let verifier = result["code_verifier"] as? String, verifier.range(of:#"^[A-Za-z0-9._~-]{43,128}$"#,options:.regularExpression) != nil,
              let challenge = result["code_challenge"] as? String,
              challenge == ChatGPTProtocol.base64URL(Data(SHA256.hash(data:Data(verifier.utf8)))) else { throw MeloError.message("Codex 授权校验失败，请重新获取验证码。") }
        return ["grant_type":"authorization_code","client_id":clientID,"code":authorization,"code_verifier":verifier,"redirect_uri":issuer + "/deviceauth/callback"]
    }
    static func refresh(_ account: CodexRegistration, session: URLSession = session) async throws -> CodexToken {
        let (data, status) = try await post("/oauth/token",["grant_type":"refresh_token","client_id":clientID,"refresh_token":account.refreshToken],session:session)
        guard status == 200 else { throw MeloError.message("Codex 登录凭证未能更新（\(status)）\(Network.rejectionDetail(data))，请重新授权。") }
        return try JSONDecoder().decode(CodexToken.self,from:data)
    }
    static func registration(_ token: CodexToken, previous: CodexRegistration? = nil, session: URLSession = session) async throws -> CodexRegistration {
        let jwks: Data
        if token.id_token != nil {
            let (body,status) = try await data(URLRequest(url:URL(string:issuer + "/.well-known/jwks.json")!),session:session)
            guard status == 200 else { throw MeloError.message("无法验证 Codex 官方身份签名，请稍后重试。") }
            jwks = body
        } else { jwks = Data() }
        return try validatedRegistration(token,jwks:jwks,previous:previous)
    }
    static func validatedRegistration(_ token: CodexToken, jwks: Data, previous: CodexRegistration? = nil, now: Date = Date()) throws -> CodexRegistration {
        guard !token.access_token.isEmpty, token.access_token.count < 64_000,
              token.token_type == nil || token.token_type?.lowercased() == "bearer",
              let refresh = token.refresh_token ?? previous?.refreshToken, !refresh.isEmpty, refresh.count < 64_000 else { throw MeloError.message("Codex 未返回完整登录凭证，请重新授权。") }
        var account = previous
        if let idToken = token.id_token {
            let identity = try ChatGPTProtocol.validateIDToken(idToken,jwks:jwks,clientID:clientID,nonce:nil,now:now)
            let claims = try payload(idToken)
            guard let auth = claims["https://api.openai.com/auth"] as? [String:Any], let accountID = auth["chatgpt_account_id"] as? String,
                  accountID.range(of:#"^[A-Za-z0-9_-]{1,180}$"#,options:.regularExpression) != nil else { throw MeloError.message("此登录未提供 Codex 账号标识，请重新授权。") }
            guard previous == nil || (previous?.subject == identity.subject && previous?.accountID == accountID) else { throw MeloError.message("返回账号与原账号不一致，原登录记录已保留。") }
            account = CodexRegistration(subject:identity.subject,accountID:accountID,email:identity.email,accessToken:"",refreshToken:"",idToken:idToken,expiresAt:now)
        }
        guard var account else { throw MeloError.message("Codex 登录没有返回身份凭证。") }
        let tokenExpiry = (try? payload(token.access_token)["exp"] as? Double) ?? nil
        let duration = token.expires_in ?? tokenExpiry.map { $0 - now.timeIntervalSince1970 } ?? 3600
        guard duration.isFinite, duration > 0 else { throw MeloError.message("Codex 返回的登录凭证已过期，请重新授权。") }
        account.accessToken=token.access_token; account.refreshToken=refresh; account.expiresAt=now.addingTimeInterval(min(duration,86400 * 10))
        return account
    }
    private static func payload(_ token: String) throws -> [String:Any] {
        let pieces = token.split(separator:".",omittingEmptySubsequences:false)
        guard pieces.count == 3, let claims = try JSONSerialization.jsonObject(with:ChatGPTProtocol.decode64(String(pieces[1]))) as? [String:Any] else { throw MeloError.message("官方身份凭证格式无效。") }
        return claims
    }
    static func revoke(_ account: CodexRegistration, session: URLSession = session) async -> Bool {
        guard !account.refreshToken.isEmpty else { return true }
        return (try? await post("/oauth/revoke",["token":account.refreshToken,"token_type_hint":"refresh_token","client_id":clientID],form:true,session:session).1) == 200
    }
    static func request(path: String, account: CodexRegistration, method: String = "GET") -> URLRequest {
        var request = URLRequest(url:URL(string:resource + path)!)
        request.httpMethod=method; request.timeoutInterval=180
        request.setValue("Bearer " + account.accessToken,forHTTPHeaderField:"Authorization")
        request.setValue(account.accountID,forHTTPHeaderField:"ChatGPT-Account-Id")
        request.setValue("melo",forHTTPHeaderField:"originator")
        request.setValue("Melo-iOS",forHTTPHeaderField:"User-Agent")
        request.setValue("responses=experimental",forHTTPHeaderField:"OpenAI-Beta")
        request.setValue("application/json",forHTTPHeaderField:"Content-Type")
        return request
    }
}

enum CodexRequest {
    static func imageBody(messages: [ChatMessage], inputs: [ImageInput], task: ImageTaskPlan, model: String, instructions: String) -> [String:Any] {
        var body=ImageRequestBody.responses(messages:messages,inputs:inputs,task:task,model:model,instructions:instructions)
        // Match the proven desktop Codex contract. The service chooses the image
        // engine; do not send unsupported public Images API model/size fields.
        body["tools"]=[["type":"image_generation"]]
        body["tool_choice"]="auto"
        if task.size != "auto" || task.quality != "auto", var input=body["input"] as? [[String:Any]], !input.isEmpty,
           var content=input[input.count-1]["content"] as? [[String:Any]], !content.isEmpty {
            let format=task.size == "1024x1536" ? "竖幅构图" : task.size == "1536x1024" ? "横幅构图" : task.size == "1024x1024" ? "正方形构图" : "尺寸由服务决定"
            content[0]["text"]=(content[0]["text"] as? String ?? "") + "\n输出偏好：" + format + "；质量偏好 " + task.quality + "。具体像素尺寸和质量以服务实际返回为准。"
            input[input.count-1]["content"]=content; body["input"]=input
        }
        return body
    }
}
