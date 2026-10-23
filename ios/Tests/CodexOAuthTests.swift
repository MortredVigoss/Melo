import Foundation
import Security
import CryptoKit

final class CodexFixture: URLProtocol, @unchecked Sendable {
    static var requests: [URLRequest] = []
    static var handler: (URLRequest) throws -> (Int,Data) = { _ in fatalError("unexpected request") }
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        do {
            Self.requests.append(request)
            let (status,data)=try Self.handler(request)
            client?.urlProtocol(self,didReceive:HTTPURLResponse(url:request.url!,statusCode:status,httpVersion:nil,headerFields:nil)!,cacheStoragePolicy:.notAllowed)
            client?.urlProtocol(self,didLoad:data); client?.urlProtocolDidFinishLoading(self)
        } catch { client?.urlProtocol(self,didFailWithError:error) }
    }
    override func stopLoading() {}
    static func body(_ request: URLRequest) -> Data {
        if let body=request.httpBody { return body }
        guard let stream=request.httpBodyStream else { return Data() }; stream.open();defer{stream.close()}
        var data=Data();var buffer=[UInt8](repeating:0,count:4096)
        while stream.hasBytesAvailable { let n=stream.read(&buffer,maxLength:buffer.count);if n<=0{break};data.append(contentsOf:buffer.prefix(n)) };return data
    }
}
@main struct CodexOAuthTests {
    static func reject(_ body: () throws -> Void) { do {try body();fatalError("invalid accepted")} catch {} }
    static func json(_ value: Any) throws -> Data { try JSONSerialization.data(withJSONObject:value) }
    @MainActor static func main() async throws {
        let config=URLSessionConfiguration.ephemeral;config.protocolClasses=[CodexFixture.self]
        let session=URLSession(configuration:config);defer{session.invalidateAndCancel()}
        let now=Date(),verifier=String(repeating:"a",count:43)
        let challenge=ChatGPTProtocol.base64URL(Data(SHA256.hash(data:Data(verifier.utf8))))
        let success:[String:String]=["authorization_code":"one-use","code_verifier":verifier,"code_challenge":challenge]
        let values=try CodexOAuth.exchangeValues(json(success))
        assert(values["redirect_uri"]=="https://auth.openai.com/deviceauth/callback" && values["client_id"]==CodexOAuth.clientID)
        var bad=success;bad["code_challenge"]="wrong";reject{_=try CodexOAuth.exchangeValues(json(bad))}
        CodexFixture.handler={ request in
            assert(request.url!.absoluteString=="https://auth.openai.com/api/accounts/deviceauth/usercode")
            let body=try JSONSerialization.jsonObject(with:CodexFixture.body(request)) as! [String:String]
            assert(body==["client_id":CodexOAuth.clientID])
            return (200,try json(["device_auth_id":"device","user_code":"AAAA-BBBB","interval":"0"]))
        }
        let code=try await CodexOAuth.begin(session:session,now:now)
        assert(code.interval==1 && code.expiresAt==now.addingTimeInterval(900))
        var polls=0,sleeps=0
        CodexFixture.handler={ request in
            if request.url!.path.hasSuffix("deviceauth/token") {
                polls+=1
                let body=try JSONSerialization.jsonObject(with:CodexFixture.body(request)) as! [String:String]
                assert(body==["device_auth_id":"device","user_code":"AAAA-BBBB"])
                return polls==1 ? (403,Data()) : polls==2 ? (404,Data()) : (200,try json(success))
            }
            assert(request.url!.absoluteString=="https://auth.openai.com/oauth/token")
            assert(request.value(forHTTPHeaderField:"Content-Type")=="application/x-www-form-urlencoded")
            assert(String(decoding:CodexFixture.body(request),as:UTF8.self).contains("grant_type=authorization_code"))
            return (200,try json(["access_token":"access","refresh_token":"refresh","id_token":"identity"]))
        }
        let token=try await CodexOAuth.poll(code,session:session,now:{now},sleep:{_ in sleeps+=1})
        assert(token.access_token=="access" && polls==3 && sleeps==2)
        let before=CodexFixture.requests.count
        do { _=try await CodexOAuth.poll(code,session:session,now:{code.expiresAt});fatalError("expiry admitted") } catch {}
        assert(CodexFixture.requests.count==before)
        CodexFixture.handler={ _ in (403,Data()) }
        do { _=try await CodexOAuth.poll(code,session:session,now:{now},sleep:{_ in throw CancellationError()});fatalError("cancel ignored") } catch is CancellationError {}
        assert(CodexFixture.requests.count==before+1)
        CodexFixture.handler={_ in (400,Data())}
        do { _=try await CodexOAuth.poll(code,session:session);fatalError("400 admitted") } catch {}
        assert(CodexFixture.requests.count==before+2)
        // A suspended iOS transport is not the user cancelling authorization.
        var interruptedPolls=0, recoveredSleeps=0
        CodexFixture.handler={request in
            if request.url!.path.hasSuffix("deviceauth/token") {
                interruptedPolls+=1
                if interruptedPolls==1 { throw URLError(.cancelled) }
                if interruptedPolls==2 { throw URLError(.networkConnectionLost) }
                return (200,try json(success))
            }
            return (200,try json(["access_token":"recovered","refresh_token":"refresh"]))
        }
        let recovered=try await CodexOAuth.poll(code,session:session,now:{now},sleep:{_ in recoveredSleeps+=1})
        assert(recovered.access_token=="recovered" && interruptedPolls==3 && recoveredSleeps==2)
        var networkFailures=0, retryClock=now
        CodexFixture.handler={_ in networkFailures+=1;throw URLError(.notConnectedToInternet)}
        do {
            _=try await CodexOAuth.poll(code,session:session,now:{retryClock},sleep:{_ in retryClock=code.expiresAt})
            fatalError("offline poll ignored expiry")
        } catch { assert(error.localizedDescription.contains("过期")) }
        assert(networkFailures==1)
        do {
            _=try await CodexOAuth.poll(code,session:session,now:{now},sleep:{_ in throw CancellationError()})
            fatalError("explicit cancellation retried")
        } catch is CancellationError {}
        assert(networkFailures==2)
        var exchanges=0, exchangePolls=0
        CodexFixture.handler={request in
            if request.url!.path.hasSuffix("deviceauth/token") { exchangePolls+=1;return (200,try json(success)) }
            exchanges+=1;throw URLError(.cancelled)
        }
        do { _=try await CodexOAuth.poll(code,session:session);fatalError("uncertain exchange replayed") }
        catch { assert(error.localizedDescription.contains("不会重复提交")) }
        assert(exchanges==1 && exchangePolls==1)
        assert(!CodexOAuth.isTransientTransport(URLError(.serverCertificateUntrusted)))
        assert(!CodexOAuth.loginError(URLError(.cancelled)).contains("cancelled"))
        let privateKey = SecKeyCreateRandomKey([kSecAttrKeyType: kSecAttrKeyTypeRSA, kSecAttrKeySizeInBits: 2048] as CFDictionary, nil)!
        let publicKey = SecKeyCopyPublicKey(privateKey)!
        let der = SecKeyCopyExternalRepresentation(publicKey, nil)! as Data
        var pos = 0
        func read() -> Data {
            pos += 1
            var count = Int(der[pos]); pos += 1
            if count & 128 != 0 { let bytes = count & 127; count = 0; for _ in 0..<bytes { count = count * 256 + Int(der[pos]); pos += 1 } }
            let result = der.subdata(in: pos..<pos+count); pos += count; return result
        }
        let sequence = read()
        var at = 0
        func integer() -> Data {
            at += 1; var size = Int(sequence[at]); at += 1
            if size & 128 != 0 { let n = size & 127; size = 0; for _ in 0..<n { size = size * 256 + Int(sequence[at]); at += 1 } }
            var result = sequence.subdata(in: at..<at+size); at += size
            while result.first == 0 { result.removeFirst() }; return result
        }
        let n = integer(), e = integer()
        let jwks = try JSONSerialization.data(withJSONObject: ["keys": [["kid": "test", "kty": "RSA", "alg": "RS256", "n": ChatGPTProtocol.base64URL(n), "e": ChatGPTProtocol.base64URL(e)]]])
        var claims: [String: Any] = ["iss": ChatGPTProtocol.issuer, "aud": CodexOAuth.clientID, "sub": "subject", "email": "test@example.invalid", "exp": now.timeIntervalSince1970 + 120, "nonce": "nonce"]
        func jwt(_ payload: [String: Any]) throws -> String {
            let header = ChatGPTProtocol.base64URL(try JSONSerialization.data(withJSONObject: ["kid": "test", "alg": "RS256"]))
            let body = ChatGPTProtocol.base64URL(try JSONSerialization.data(withJSONObject: payload))
            let input = header + "." + body
            let signature = SecKeyCreateSignature(privateKey, .rsaSignatureMessagePKCS1v15SHA256, Data(input.utf8) as CFData, nil)! as Data
            return input + "." + ChatGPTProtocol.base64URL(signature)
        }
        claims["https://api.openai.com/auth"]=["chatgpt_account_id":"account-id"]
        let id=try jwt(claims)
        let grant=CodexToken(access_token:"opaque-access",refresh_token:"refresh",id_token:id,expires_in:3600,token_type:"Bearer")
        let account=try CodexOAuth.validatedRegistration(grant,jwks:jwks,now:now)
        assert(account.accountID=="account-id" && account.subject=="subject")
        reject{_=try CodexOAuth.validatedRegistration(grant,jwks:Data("{}".utf8),now:now)}
        var other=account;other.subject="someone-else"
        reject{_=try CodexOAuth.validatedRegistration(grant,jwks:jwks,previous:other,now:now)}
        var request=CodexOAuth.request(path:"/responses",account:account,method:"POST")
        assert(request.url!.absoluteString=="https://chatgpt.com/backend-api/codex/responses")
        assert(request.value(forHTTPHeaderField:"Authorization")=="Bearer opaque-access" && request.value(forHTTPHeaderField:"ChatGPT-Account-Id")=="account-id")
        CodexFixture.handler={request in
            assert(request.url!.path=="/oauth/token")
            let body=try JSONSerialization.jsonObject(with:CodexFixture.body(request)) as! [String:String]
            assert(body==["client_id":CodexOAuth.clientID,"grant_type":"refresh_token","refresh_token":"refresh"])
            return (200,try json(["access_token":"new-access","refresh_token":"rotated","expires_in":7200]))
        }
        let refreshed=try await CodexOAuth.refresh(account,session:session)
        let updated=try CodexOAuth.validatedRegistration(refreshed,jwks:Data(),previous:account,now:now)
        assert(updated.accountID==account.accountID && updated.refreshToken=="rotated" && updated.expiresAt==now.addingTimeInterval(7200))
        reject{_=try CodexOAuth.validatedRegistration(refreshed,jwks:Data(),now:now)}
        let input=ImageInput(data:Data([1,2,3]),mimeType:"image/png",role:"reference")
        let task=ImageTaskPlan(action:.edit,references:[.init(id:"original")])
        let body=CodexRequest.imageBody(messages:[ChatMessage(role:"user",content:"换成黑色背景")],inputs:[input],task:task,model:"gpt-6.1-sol",instructions:"")
        assert(body["model"] as? String=="gpt-6.1-sol")
        assert((body["tools"] as? [[String:String]])==[["type":"image_generation","quality":"high"]] && body["tool_choice"] as? String=="auto")
        let rows=body["input"] as! [[String:Any]], content=rows[0]["content"] as! [[String:Any]]
        assert(content[1]["image_url"] as? String==input.dataURL)
        request.httpBody=try json(body)
        let png="iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg=="
        let imageEvent:[String:Any]=["type":"response.output_item.done","item":["type":"image_generation_call","status":"completed","result":png]]
        var stream=ChatGPTStream(acceptImageCompletion:true)
        try stream.accept(String(decoding:json(["type":"response.created","response":["tools":[["type":"image_generation","model":"gpt-image-2-codex"]]]]),as:UTF8.self))
        try stream.accept(String(decoding:json(imageEvent),as:UTF8.self))
        assert(stream.completed && stream.images.count==1 && stream.images[0].reportedModel=="gpt-image-2-codex")
        var regular=ChatGPTStream();try regular.accept(String(decoding:json(imageEvent),as:UTF8.self));assert(!regular.completed)
        var partial=ChatGPTStream(acceptImageCompletion:true)
        try partial.accept(#"{"type":"response.image_generation_call.partial_image","partial_image_b64":"a"}"#)
        assert(!partial.completed && partial.images.isEmpty)
        let defaults=UserDefaults(suiteName:"Melo-Codex-QA-"+UUID().uuidString)!
        var persisted="", writes=0, lifecyclePolls=0, keyReads=0, lifecycleExchanges=0
        CodexFixture.handler={ request in
            switch request.url!.path {
            case "/api/accounts/deviceauth/usercode": return (200,try json(["device_auth_id":"device","user_code":"AAAA-BBBB","interval":"1"]))
            case "/api/accounts/deviceauth/token":
                lifecyclePolls+=1
                if lifecyclePolls==1 { throw URLError(.cancelled) }
                return (200,try json(success))
            case "/oauth/token":
                lifecycleExchanges+=1
                return (200,try json(["access_token":"access","refresh_token":"refresh","id_token":id,"expires_in":3600]))
            case "/.well-known/jwks.json":
                keyReads+=1
                if keyReads==1 { throw URLError(.networkConnectionLost) }
                return (200,jwks)
            case "/backend-api/codex/models":
                assert(request.url!.query=="client_version=0.180.0")
                return (200,try json(["models":[["slug":"gpt-6.1-sol","display_name":"Sol 6.1","visibility":"list"]]]))
            default: fatalError("Unexpected auth endpoint")
            }
        }
        let login=ChatGPTAccount(session:session,defaults:defaults,readCredentials:{""},persistCredentials:{persisted=$0;writes+=1},prepareStorage:{})
        login.setApplicationActive(false)
        await login.signIn()
        let waitingCode=login.deviceCode?.id
        try await Task.sleep(for:.milliseconds(250))
        assert(login.busy && waitingCode != nil && lifecyclePolls==0 && writes==0)
        login.setApplicationActive(true)
        for _ in 0..<100 { if login.status.contains("连接暂时中断") { break };try await Task.sleep(for:.milliseconds(20)) }
        assert(login.busy && login.error==nil && login.deviceCode?.id==waitingCode && lifecyclePolls==1)
        login.setApplicationActive(false)
        try await Task.sleep(for:.milliseconds(1200))
        assert(lifecyclePolls==1 && writes==0) // No background poll and no new usercode request.
        login.setApplicationActive(true)
        for _ in 0..<200 { if !login.models.isEmpty { break };try await Task.sleep(for:.milliseconds(20)) }
        assert(login.signedIn && !login.busy && login.deviceCode==nil && login.models.first?.slug=="gpt-6.1-sol" && writes==1)
        assert(lifecyclePolls==2 && lifecycleExchanges==1 && keyReads==2)
        let restored=ChatGPTAccount(session:session,defaults:defaults,readCredentials:{persisted},persistCredentials:{_ in},prepareStorage:{})
        assert(restored.active?.accountID=="account-id")
        let cancelled=ChatGPTAccount(session:session,defaults:defaults,readCredentials:{""},persistCredentials:{_ in fatalError("cancelled login saved credentials")},prepareStorage:{})
        cancelled.setApplicationActive(false)
        await cancelled.signIn()
        cancelled.cancelLogin();cancelled.setApplicationActive(true)
        try await Task.sleep(for:.milliseconds(250))
        assert(!cancelled.busy && cancelled.deviceCode==nil && cancelled.error==nil && lifecyclePolls==2)
        var expired=account;expired.expiresAt = .distantPast
        defaults.set(expired.id,forKey:"codexActiveID")
        let encoded=String(decoding:try JSONEncoder().encode([expired]),as:UTF8.self)
        var refreshCalls=0, refreshWrites=0
        CodexFixture.handler={request in
            if request.url!.path=="/oauth/token" {
                refreshCalls+=1
                return (200,try json(["access_token":"new-access","refresh_token":"rotated","expires_in":3600]))
            }
            assert(request.url!.path=="/backend-api/codex/models")
            return (200,try json(["models":[["slug":"gpt-6.1-sol","display_name":"Sol 6.1","visibility":"list"]]]))
        }
        let refreshing=ChatGPTAccount(session:session,defaults:defaults,readCredentials:{encoded},persistCredentials:{_ in refreshWrites+=1},prepareStorage:{})
        async let first: Void=refreshing.loadModels()
        async let second: Void=refreshing.loadModels()
        _=await(first,second)
        assert(refreshCalls==1 && refreshWrites==1 && refreshing.active?.refreshToken=="rotated")
        let imageSSE="data: " + String(decoding:try json(imageEvent),as:UTF8.self) + "\n\n"
        var imageRequests=0
        CodexFixture.handler={ request in
            imageRequests+=1;assert(request.url!.path=="/backend-api/codex/responses")
            let requestBody=try JSONSerialization.jsonObject(with:CodexFixture.body(request)) as! [String:Any]
            assert(requestBody["model"] as? String=="gpt-6.1-sol" && requestBody["store"] as? Bool==false)
            return (200,Data(imageSSE.utf8))
        }
        let result=try await refreshing.reply(messages:[ChatMessage(role:"user",content:"换成黑色背景")],model:"gpt-6.1-sol",instructions:"",imageInputs:[input],imageTask:task)
        assert(result.images.count==1 && imageRequests==1 && refreshing.imageVerified)
        CodexFixture.handler={_ in imageRequests+=1;return (400,try json(["error":["code":"unsupported_tool"]]))}
        do { _=try await refreshing.reply(messages:[ChatMessage(role:"user",content:"改背景")],model:"gpt-6.1-sol",instructions:"",imageInputs:[input],imageTask:task);fatalError("400 admitted") } catch { assert(error.localizedDescription.contains("unsupported_tool")) }
        assert(imageRequests==2) // No automatic regeneration or API fallback.
        // Phone data tool loop: round 1 asks for a function call; Melo executes it
        // once and replays reasoning + call + output; round 2 answers in text.
        func sse(_ output: [[String:Any]]) throws -> Data {
            Data(("data: " + String(decoding:try json(["type":"response.completed","response":["status":"completed","output":output]]),as:UTF8.self) + "\n\n").utf8)
        }
        func checkReply(_ body: [String: Any]) throws -> (Int, Data)? {
            guard (body["instructions"] as? String ?? "").hasPrefix("You are Melo's task completion checker") else { return nil }
            assert(body["tools"] == nil && body["tool_choice"] == nil, "checking has no native search, image or phone effects")
            let report = #"{"decision":"partial","reasonType":"unavailable","requirements":[{"text":"fixture delivery","status":"missing","evidenceIds":[]}]}"#
            return (200, try sse([["type":"message", "content":[["type":"output_text", "text":report, "annotations":[]]]]]))
        }
        let toolCall:[String:Any]=["type":"function_call","id":"fc_1","call_id":"call_cal","name":"calendar_list_events","arguments":"{\"start\":\"2026-10-17T00:00:00+11:00\",\"end\":\"2026-10-18T00:00:00+11:00\"}","status":"completed"]
        let thinking:[String:Any]=["type":"reasoning","id":"rs_1","summary":[],"encrypted_content":"opaque"]
        var toolRounds=0, executed=0, recorded=0
        CodexFixture.handler={ request in
            toolRounds+=1
            let body=try JSONSerialization.jsonObject(with:CodexFixture.body(request)) as! [String:Any]
            if let check = try checkReply(body) { return check }
            let tools=body["tools"] as? [[String:Any]] ?? []
            assert(tools.contains { $0["name"] as? String=="calendar_list_events" } && !tools.contains { $0["name"] as? String=="contacts_search" })
            assert((body["include"] as? [String])?.contains("reasoning.encrypted_content")==true)
            assert(body["tool_choice"] as? String == "auto", "A local calendar lookup must not be forced to web search")
            let input=body["input"] as? [[String:Any]] ?? []
            if toolRounds==1 {
                assert(!input.contains { $0["type"] as? String=="function_call_output" })
                return (200,try sse([thinking,toolCall]))
            }
            assert(input.contains { $0["type"] as? String=="reasoning" && $0["encrypted_content"] as? String=="opaque" })
            assert(input.contains { $0["type"] as? String=="function_call" && $0["call_id"] as? String=="call_cal" })
            assert(input.contains { $0["type"] as? String=="function_call_output" && $0["call_id"] as? String=="call_cal" && ($0["output"] as? String)?.contains("牙医")==true })
            return (200,try sse([["type":"message","content":[["type":"output_text","text":"明天 9 点看牙医。","annotations":[]]]]]))
        }
        let phone=DeviceToolContext(policy:DeviceToolPolicy(enabled:[.calendar]),execute:{ call in
            executed+=1; assert(call.callID=="call_cal")
            return "{\"ok\":true,\"count\":1,\"events\":[{\"title\":\"牙医\"}]}"
        },onCall:{ _,_ in recorded+=1 })
        let answered=try await refreshing.reply(messages:[ChatMessage(role:"user",content:"查一下我明天的日程")],model:"gpt-6.1-sol",instructions:"",deviceTools:phone)
        assert(answered.text=="明天 9 点看牙医。" && toolRounds==3 && executed==1 && recorded==1)
        // A model that never stops calling tools is cut off like the desktop (2026-10-19; was 6 rounds and an
        // error): 10 model calls, then the shared tool-limit reply instead of a fabricated answer.
        toolRounds=0; executed=0
        CodexFixture.handler={ _ in toolRounds+=1; return (200,try sse([["type":"function_call","call_id":"call_\(toolRounds)","name":"calendar_list_events","arguments":"{}","status":"completed"]])) }
        let looping=DeviceToolContext(policy:DeviceToolPolicy(enabled:[.calendar]),execute:{ _ in executed+=1; return "{\"ok\":true,\"newEventCount\":\(executed)}" })
        let limited=try await refreshing.reply(messages:[ChatMessage(role:"user",content:"一直查")],model:"gpt-6.1-sol",instructions:"",deviceTools:looping)
        assert(limited.text==AgentLoopContract.shared.toolLimitReplyZH && toolRounds==AgentLoopContract.shared.maxIterations && executed==AgentLoopContract.shared.maxIterations)
        // Time-sensitive questions keep search available, while allowing phone data first.
        // The final tool-free check preserves an unverified candidate rather than throwing it away.
        toolRounds=0; executed=0
        CodexFixture.handler={ request in
            toolRounds+=1
            let body=try JSONSerialization.jsonObject(with:CodexFixture.body(request)) as! [String:Any]
            if let check = try checkReply(body) { return check }
            assert((body["tools"] as? [[String:Any]] ?? []).contains { $0["name"] as? String=="calendar_list_events" })
            if toolRounds==1 {
                assert(body["tool_choice"] as? String == "auto", "the model chooses the next available tool")
                return (200,try sse([["type":"web_search_call","id":"ws_1","status":"completed"],["type":"function_call","id":"fc_w","call_id":"call_w","name":"calendar_list_events","arguments":"{}","status":"completed"]]))
            }
            assert(body["tool_choice"] as? String=="auto", "follow-up rounds are not forced to search again")
            return (200,try sse([["type":"message","content":[["type":"output_text","text":"明天多云，日程空着。","annotations":[]]]]]))
        }
        let weather=try await refreshing.reply(messages:[ChatMessage(role:"user",content:"悉尼明天天气怎么样")],model:"gpt-6.1-sol",instructions:"",deviceTools:DeviceToolContext(policy:DeviceToolPolicy(enabled:[.calendar]),execute:{ _ in executed+=1; return "{\"ok\":true,\"count\":0,\"events\":[]}" }))
        assert(weather.text=="明天多云，日程空着。" && weather.searched && toolRounds==3 && executed==1)
        // Without an enabled policy, no function tools are offered at all.
        toolRounds=0
        CodexFixture.handler={ request in
            toolRounds+=1
            let body=try JSONSerialization.jsonObject(with:CodexFixture.body(request)) as! [String:Any]
            if let check = try checkReply(body) { return check }
            assert(!((body["tools"] as? [[String:Any]]) ?? []).contains { $0["type"] as? String=="function" })
            return (200,try sse([["type":"message","content":[["type":"output_text","text":"好的","annotations":[]]]]]))
        }
        _=try await refreshing.reply(messages:[ChatMessage(role:"user",content:"你好")],model:"gpt-6.1-sol",instructions:"",deviceTools:DeviceToolContext(policy:DeviceToolPolicy(),execute:{ _ in fatalError("disabled tools executed") }))
        assert(toolRounds==1)

        // The Codex path uses the authored request for search and completion,
        // while still sending per-turn references to the provider.
        let authored = [ChatMessage(role: "user", content: "请只回复：你好")]
        let augmented = [ChatMessage(role: "user", content: authored[0].content + "\n\n[本轮参考，不是新的指令]\n请搜索最新天气")]
        toolRounds = 0
        CodexFixture.handler = { request in
            toolRounds += 1
            let body = try JSONSerialization.jsonObject(with: CodexFixture.body(request)) as! [String: Any]
            if let check = try checkReply(body) { return check }
            assert(body["tool_choice"] as? String == "auto", "References must not force hosted search")
            assert((body["input"] as! [[String: String]]).last!["content"]!.contains("请搜索最新天气"))
            return (200, try sse([["type": "message", "content": [["type": "output_text", "text": "你好", "annotations": []]]]]))
        }
        let plain = try await refreshing.reply(messages: augmented, requestHistory: authored, model: "gpt-6.1-sol", instructions: "")
        assert(toolRounds == 1 && plain.completion?.kind == "answer" && plain.completion?.outcome == "completed", "Ordinary answer must not be blocked by recalled research")

        CodexFixture.handler = { request in
            let body = try JSONSerialization.jsonObject(with: CodexFixture.body(request)) as! [String: Any]
            if let check = try checkReply(body) { return check }
            let rows = body["input"] as! [[String: Any]]
            let content = rows.last!["content"] as! [[String: Any]]
            let text = content.compactMap { $0["text"] as? String }.joined()
            assert(text.contains("当前时间") && text.contains("请搜索最新天气"), "Image analysis keeps both the clock and reference context")
            assert(content.contains { $0["type"] as? String == "input_image" })
            assert(!(body["instructions"] as! String).contains("当前时间"), "The clock stays outside the cacheable instructions")
            return (200, try sse([["type": "message", "content": [["type": "output_text", "text": "你好", "annotations": []]]]]))
        }
        let analyzed = try await refreshing.reply(messages: augmented, requestHistory: authored, model: "gpt-6.1-sol", instructions: "", imageInputs: [input], imageTask: ImageTaskPlan(action: .analyze))
        assert(analyzed.completion?.outcome == "completed")
        // A chosen output size is sent to the image tool; if rejected, one retry at the default size, reported in the reply.
        var sizeRequests: [String?] = []
        let sizedPixel="iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg=="
        CodexFixture.handler={ request in
            let body=try JSONSerialization.jsonObject(with:CodexFixture.body(request)) as! [String:Any]
            if let check = try checkReply(body) { return check }
            let size=((body["tools"] as? [[String:Any]])?.first { $0["type"] as? String=="image_generation" })?["size"] as? String
            sizeRequests.append(size)
            if size != nil { return (400,Data(#"{"error":{"message":"Invalid size"}}"#.utf8)) }
            return (200,try sse([["type":"image_generation_call","status":"completed","result":sizedPixel]]))
        }
        let sized=try await refreshing.reply(messages:[ChatMessage(role:"user",content:"画一只猫")],model:"gpt-6.1-sol",instructions:"",imageTask:ImageTaskPlan(action:.generate,size:"3824x2144"))
        assert(sizeRequests==["3824x2144",nil], "exactly one retry without size: \(sizeRequests)")
        assert(sized.images.count==1 && sized.text.contains("服务未接受所选尺寸"))
        // Ordinary replies offer the image tool only when this Agent may make images here;
        // the model decides, and an image it returns is delivered instead of "missing tool".
        var imageRounds=0
        let onePixel="iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg=="
        CodexFixture.handler={ request in
            imageRounds+=1
            let body=try JSONSerialization.jsonObject(with:CodexFixture.body(request)) as! [String:Any]
            if let check = try checkReply(body) { return check }
            let tools=(body["tools"] as? [[String:Any]]) ?? []
            assert(tools.contains { $0["type"] as? String=="image_generation" && $0["action"]==nil }, "image tool offered without forcing an action")
            assert(body["tool_choice"] as? String=="auto" && (body["instructions"] as? String ?? "").contains("不要说缺少工具"))
            return (200,try sse([["type":"image_generation_call","status":"completed","result":onePixel]]))
        }
        let drawn=try await refreshing.reply(messages:[ChatMessage(role:"user",content:"把天空弄成晚霞的感觉吧")],model:"gpt-6.1-sol",instructions:"",allowWebSearch:false,allowImageTool:true,statusKey:"chat-a")
        assert(imageRounds==1 && drawn.images.count==1, "image returned by the auto tool must be kept")
        assert(refreshing.replyStatuses["chat-a"]==nil, "per-chat status is cleared when the reply ends")
        CodexFixture.handler={ request in
            imageRounds+=1
            let body=try JSONSerialization.jsonObject(with:CodexFixture.body(request)) as! [String:Any]
            if let check = try checkReply(body) { return check }
            assert(!((body["tools"] as? [[String:Any]]) ?? []).contains { $0["type"] as? String=="image_generation" }, "no image tool without permission")
            return (200,try sse([["type":"message","content":[["type":"output_text","text":"好的","annotations":[]]]]]))
        }
        _=try await refreshing.reply(messages:[ChatMessage(role:"user",content:"把天空弄成晚霞的感觉吧")],model:"gpt-6.1-sol",instructions:"",allowWebSearch:false,allowImageTool:false)
        assert(imageRounds==2)
        // An Agent without phone search permission gets no web_search tool, even for news-style questions.
        var searchRounds=0
        CodexFixture.handler={ request in
            searchRounds+=1
            let body=try JSONSerialization.jsonObject(with:CodexFixture.body(request)) as! [String:Any]
            if let check = try checkReply(body) { return check }
            assert(!((body["tools"] as? [[String:Any]]) ?? []).contains { $0["type"] as? String=="web_search" })
            return (200,try sse([["type":"message","content":[["type":"output_text","text":"无法联网","annotations":[]]]]]))
        }
        _=try await refreshing.reply(messages:[ChatMessage(role:"user",content:"今天的新闻")],model:"gpt-6.1-sol",instructions:"",allowWebSearch:false)
        assert(searchRounds==2)
        // Same question with permission: the search tool is offered.
        CodexFixture.handler={ request in
            searchRounds+=1
            let body=try JSONSerialization.jsonObject(with:CodexFixture.body(request)) as! [String:Any]
            if let check = try checkReply(body) { return check }
            assert(((body["tools"] as? [[String:Any]]) ?? []).contains { $0["type"] as? String=="web_search" })
            return (200,Data(("data: "+String(decoding:try json(["type":"response.completed","response":["status":"completed","output":[["type":"web_search_call","status":"completed"],["type":"message","content":[["type":"output_text","text":"已搜索","annotations":[]]]]]]]),as:UTF8.self)+"\n\n").utf8))
        }
        _=try await refreshing.reply(messages:[ChatMessage(role:"user",content:"今天的新闻")],model:"gpt-6.1-sol",instructions:"",allowWebSearch:true)
        assert(searchRounds==4)
        print("Codex OAuth tests passed: background pause/resume, transport recovery, explicit cancellation, expiry, single-use exchange, PKCE, signed identity, account binding, refresh and image delivery; no live login")
    }
}
