#if DEBUG && targetEnvironment(simulator)
import Foundation

@MainActor enum WebPageVerification {
    static func run() async {
        let support = FileManager.default.urls(for:.applicationSupportDirectory,in:.userDomainMask)[0]
        var receipt:[String:Any] = ["passed":false]
        let loader=WebPageLoader(); defer{loader.detach()}
        do {
            let body=String(repeating:"Verified static paragraph. ",count:20)
            let html="<html><head><title>Static source</title><script>document.body.textContent='UNTRUSTED SCRIPT RAN'</script></head><body><main>"+body+"</main></body></html>"
            let snapshot=PhonePageHTTP.Snapshot(url:"https://public.example/source",text:html,mime:"text/html",status:200)
            let start=Date(); let value=try await loader.extractHTTP(snapshot)
            guard value?.title=="Static source",value?.text.contains("Verified static paragraph") == true,value?.text.contains("UNTRUSTED SCRIPT RAN") == false else {throw MeloError.message("Static extraction or inert HTML failed")}
            receipt["staticExtractionMs"]=Date().timeIntervalSince(start)*1000
            let shell=PhonePageHTTP.Snapshot(url:snapshot.url,text:"<main aria-busy='true'>"+body+"</main>",mime:"text/html",status:200)
            guard try await loader.extractHTTP(shell)==nil else{throw MeloError.message("Busy shell was treated as evidence")}
            receipt["passed"]=true
            let remoteStart=Date()
            do {
                let remote=try await PhonePageHTTP.read(URL(string:"https://www.rfc-editor.org/rfc/rfc9110.txt")!)
                receipt["publicHTTPAvailable"]=remote?.text.contains("HTTP Semantics") == true
                receipt["publicHTTPStatus"]=remote?.status as Any? ?? NSNull()
            }catch{receipt["publicHTTPErrorType"]=String(describing:type(of:error))}
            receipt["publicHTTPMs"]=Date().timeIntervalSince(remoteStart)*1000
        }catch{receipt["error"]=error.localizedDescription}
        try? JSONSerialization.data(withJSONObject:receipt,options:[.prettyPrinted,.sortedKeys]).write(to:support.appendingPathComponent("webpage-latency-verification.json"),options:.atomic)
    }
}
#endif
