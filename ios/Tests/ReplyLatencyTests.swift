import Foundation
final class ReadTransport: AgentModelTransport, @unchecked Sendable {
 let offersTools=true;let timeoutCap:TimeInterval=10
 var requests=0
 func round(_ request:AgentLoopRequest) async throws -> AgentRound {
  requests+=1
  if request.goalReview != nil { return AgentRound(text:#"{"decision":"complete","reasonType":"fulfilled","requirements":[{"text":"Read both pages","kind":"external_fact","status":"met","evidenceIds":["a","b"]}]}"#) }
  if requests == 1 { return AgentRound(calls:[ResponsesFunctionCall(callID:"a",name:"open_url",arguments:#"{"url":"https://a.example"}"#),ResponsesFunctionCall(callID:"b",name:"open_url",arguments:#"{"url":"https://b.example"}"#)]) }
  return AgentRound(text:"The first page says A, the second says B.")
 }
 func complete(system:String,messages:[ChatMessage],timeout:TimeInterval) async throws -> String { "" }
}
final class BatchTransport: AgentModelTransport, @unchecked Sendable {
 let offersTools=true;let timeoutCap:TimeInterval=10
 let index:Int;var requests=0;let forbidden:Bool
 init(_ index:Int=0, forbidden:Bool=false){self.index=index;self.forbidden=forbidden}
 func forkForMember(_ index:Int)->(any AgentModelTransport)? { BatchTransport(index,forbidden:forbidden) }
 func round(_ request:AgentLoopRequest) async throws -> AgentRound {
  requests+=1
  if request.goalReview != nil {
   let ids=index == 0 ? ["job-1:read","job-2:read"] : ["job-\(index):read"]
   let data=try JSONSerialization.data(withJSONObject:["decision":"complete","reasonType":"fulfilled","requirements":[["text":"Read source", "kind":"external_fact","status":"met","evidenceIds":ids]]])
   return AgentRound(text:String(data:data,encoding:.utf8)!)
  }
  if requests==1 {
   if index==0 {return AgentRound(calls:[1,2].map{ResponsesFunctionCall(callID:"route-\($0)",name:"route_task",arguments:"{\"role\":\"research\",\"task\":\"Read source \($0)\"}")})}
   assert(request.internalJob != nil && request.onDraft == nil)
   return AgentRound(calls:[ResponsesFunctionCall(callID:"read",name:forbidden ? "file_write" : "open_url",arguments:"{\"url\":\"https://source\(index).example\"}")])
  }
  return AgentRound(text:"The sources report A and B.")
 }
 func complete(system:String,messages:[ChatMessage],timeout:TimeInterval) async throws->String { "" }
}
final class RejectedBatchTransport: AgentModelTransport, @unchecked Sendable {
 let offersTools=true;let timeoutCap:TimeInterval=10
 var requests=0
 func round(_ request:AgentLoopRequest) async throws -> AgentRound {
  requests+=1
  if requests>8 { return AgentRound(text:"Unable to read source.") }
  return AgentRound(calls:[1,2].map { ResponsesFunctionCall(callID:"invalid-\(requests)-\($0)",name:"route_task",arguments:#"{"role":"unknown","task":"Read source"}"#) })
 }
 func complete(system:String,messages:[ChatMessage],timeout:TimeInterval) async throws->String { "" }
}
final class PageHTTPFixture: URLProtocol, @unchecked Sendable {
 static var status=200, mime="text/plain", body="Complete public source", requests=0
 override class func canInit(with request:URLRequest)->Bool {true}
 override class func canonicalRequest(for request:URLRequest)->URLRequest {request}
 override func startLoading(){
  Self.requests+=1
  client?.urlProtocol(self,didReceive:HTTPURLResponse(url:request.url!,statusCode:Self.status,httpVersion:nil,headerFields:["Content-Type":Self.mime])!,cacheStoragePolicy:.notAllowed)
  client?.urlProtocol(self,didLoad:Data(Self.body.utf8));client?.urlProtocolDidFinishLoading(self)
 }
 override func stopLoading(){}
}
@main struct ReplyLatencyTests {
 @MainActor static func main() async throws {
  var active=0,peak=0,performed=[String](),records=[ExecutionToolCall]()
  let tools=AgentLoopTools(definitions:[WebPageToolSpec.all[0].definition],instructions:"read",perform:{ call in
   active+=1;peak=max(peak,active);defer {active-=1};performed.append(call.callID)
   do {try await Task.sleep(for:.milliseconds(300))}catch{return PhoneToolResult(output:PhoneToolEnvelope.success("cancelled"))}
   return PhoneToolResult(output:PhoneToolEnvelope.success("Page "+call.callID+": verified body"))
  })
  let t=Date();let reply=try await AgentLoop(transport:ReadTransport(),tools:tools,budget:PhoneRunBudget(),latestUserMessage:"Read both pages",hooks:AgentLoopHooks(onToolCall:{records.append($0)})).run()
  assert(peak == 2 && performed.sorted() == ["a", "b"] && records.count == 2)
  assert(reply.completion?.outcome == "completed" && active == 0)
  let elapsed=Date().timeIntervalSince(t)
  assert(elapsed >= 0.3) // Peak overlap above is the regression; elapsed is reported, not a load-sensitive gate.
  var batchPeak=0,batchActive=0,batchIDs=[String](),saved:PhoneReplyCursor?
  let batchTools=AgentLoopTools(definitions:[WebPageToolSpec.all[0].definition],instructions:"Read source",perform:{call in
   batchActive+=1;batchPeak=max(batchPeak,batchActive);defer{batchActive-=1};batchIDs.append(call.callID)
   try? await Task.sleep(for:.milliseconds(300))
   return PhoneToolResult(output:PhoneToolEnvelope.success("Source reports A and B."))
  })
  var batchHooks=AgentLoopHooks();batchHooks.internalRouting=true;batchHooks.saveCursor={saved=$0}
  let batchBudget=PhoneRunBudget()
  let batched=try await AgentLoop(transport:BatchTransport(),tools:batchTools,budget:batchBudget,latestUserMessage:"Read both sources and report",hooks:batchHooks).run()
  assert(batchPeak==2 && Set(batchIDs)==Set(["job-1:read","job-2:read"]))
  assert(batched.completion?.outcome=="completed" && batchBudget.used.toolCalls==2)
  let savedRows=try JSONSerialization.jsonObject(with:saved!.observations!) as! [[String:Any]]
  assert(Set(savedRows.compactMap{$0["id"] as? String}).isSuperset(of:Set(batchIDs)))
  assert(saved?.receipts.count==2 && saved?.inFlightEffect==nil)
  batchIDs=[];batchActive=0;batchPeak=0
  let oneBudget=PhoneRunBudget(maxToolCalls:1)
  _ = try await AgentLoop(transport:BatchTransport(),tools:batchTools,budget:oneBudget,latestUserMessage:"Read both sources",hooks:batchHooks).run()
  assert(batchIDs.count==1 && oneBudget.used.toolCalls==1, "Parallel members must share the parent's tool admission")
  batchIDs=[]
  let cancelTask=Task {try await AgentLoop(transport:BatchTransport(),tools:batchTools,budget:PhoneRunBudget(),latestUserMessage:"Read both sources",hooks:batchHooks).run()}
  try await Task.sleep(for:.milliseconds(100));cancelTask.cancel()
  do {_ = try await cancelTask.value;assertionFailure("Cancellation must propagate")}catch{}
  assert(batchIDs.count<=2 && batchActive==0)
  batchIDs=[]
  _ = try await AgentLoop(transport:BatchTransport(forbidden:true),tools:batchTools,budget:PhoneRunBudget(),latestUserMessage:"Read both sources",hooks:batchHooks).run()
  assert(batchIDs.isEmpty, "A member may not reach the dispatcher with a tool outside its scope")
  let preCancelled=Task {try await AgentLoop(transport:BatchTransport(),tools:batchTools,budget:PhoneRunBudget(),latestUserMessage:"Read both sources",hooks:batchHooks).run()}
  preCancelled.cancel();do{_ = try await preCancelled.value;assertionFailure("Pre-cancelled run completed")}catch{}
  assert(batchIDs.isEmpty, "Cancellation before admission must execute zero calls")
  let rejectedTransport=RejectedBatchTransport()
  let rejected=try await AgentLoop(transport:rejectedTransport,tools:batchTools,budget:PhoneRunBudget(),latestUserMessage:"Read both sources",hooks:batchHooks).run()
  assert(rejectedTransport.requests==3 && rejected.stop == .toolLimit, "Rejected-only routing batches must use the ordinary failure counter")
  assert(batchIDs.isEmpty, "Invalid assignments must execute zero member tools")
  let config=URLSessionConfiguration.ephemeral;config.protocolClasses=[PageHTTPFixture.self]
  let httpSession=URLSession(configuration:config);defer{httpSession.invalidateAndCancel()}
  let http=try await PhonePageHTTP.read(URL(string:"https://public.example/source")!,session:httpSession)
  assert(http?.text==PageHTTPFixture.body && http?.status==200)
  let blocked=try await PhonePageHTTP.read(URL(string:"http://127.0.0.1/private")!,session:httpSession)
  assert(blocked==nil && PageHTTPFixture.requests==1)
  PageHTTPFixture.status=403
  let denied=try await PhonePageHTTP.read(URL(string:"https://public.example/source")!,session:httpSession)
  assert(denied==nil)
  PageHTTPFixture.status=200;PageHTTPFixture.mime="application/octet-stream"
  let binary=try await PhonePageHTTP.read(URL(string:"https://public.example/source")!,session:httpSession)
  assert(binary==nil)
  let cache=PhonePageCache(), now=Date()
  let first=cache.store("https://a.example",finalURL:"https://a.example/v1",title:"A",description:"",text:"first complete body",status:200,complete:true,now:now)!
  assert(cache.get("https://a.example",now:now.addingTimeInterval(29))?.version == first.version)
  assert(cache.get("https://a.example",now:now.addingTimeInterval(31)) == nil)
  assert(cache.get("https://b.example",now:now) == nil && PhonePageCache().get("https://a.example",now:now) == nil)
  assert(cache.store("https://partial.example",finalURL:"",title:"",description:"",text:"unfinished",status:200,complete:false) == nil)
  assert(cache.store("https://failed.example",finalURL:"",title:"",description:"",text:"Error",status:503,complete:true) == nil)
  let changed=cache.store("https://a.example",finalURL:"https://a.example/v1",title:"A",description:"",text:"updated body",status:200,complete:true,now:now)!
  assert(changed.version != first.version)
  cache.invalidate("https://a.example")
  assert(cache.store("https://a.example",finalURL:"",title:"",description:"",text:"failed refresh",status:503,complete:true)==nil)
  assert(cache.get("https://a.example",now:now)==nil, "A failed fresh page-one read cannot leave an older snapshot available as page two")
  var clock=ExecutionRecord(chatId:"test",query:"hello",requestedModel:"fixture")
  clock.startedAt="2026-11-09T10:00:00Z";clock.finishedAt="2026-11-09T10:01:00Z";clock.status="completed"
  clock.activeIntervals=[ExecutionActivity(startedAt:"2026-11-09T10:00:00Z",finishedAt:"2026-11-09T10:00:10Z"),ExecutionActivity(startedAt:"2026-11-09T10:00:40Z",finishedAt:"2026-11-09T10:01:00Z")]
  assert(clock.elapsedMilliseconds() == 60000 && clock.activeMilliseconds() == 30000 && clock.pausedMilliseconds() == 30000)
  let decoded=try JSONDecoder().decode(ExecutionRecord.self,from:JSONEncoder().encode(clock))
  assert(decoded.pausedMilliseconds() == 30000)
  let value:[String:Any]=["elapsedMs":elapsed*1000,"peak":peak,"calls":performed.count,"records":records.count,"outcome":reply.completion?.outcome ?? "unknown"]
  print(String(data:try JSONSerialization.data(withJSONObject:value,options:[.sortedKeys]),encoding:.utf8)!)
 }
}
