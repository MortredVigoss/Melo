#!/usr/bin/env python3
"""Exercise the saved key through the native UI, a cold launch and a chat on an isolated simulator."""
import http.server
import json
import os
from pathlib import Path
import ssl
import subprocess
import tempfile
import threading

ROOT = Path(__file__).resolve().parents[2]

def cmd(*args, **options):
    return subprocess.check_output([str(a) for a in args], text=True, cwd=ROOT, **options).strip()

def sim(*args):
    return cmd('xcrun', 'simctl', *args)

class Provider(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        allowed = (self.path == '/v1/chat/completions' and body.get('model') == 'melo-ui-fixture'
                   and self.headers.get('Authorization') == 'Bearer melo-ui-fixture-key')
        messages = body.get('messages', [])
        probe = any('2 + 2' in str(m.get('content')) for m in messages)
        answer = 'MELO_KEY_ACCEPTED' if probe else 'MELO_CHAT_ACCEPTED'
        self.server.receipts.append(('probe' if probe else 'chat', allowed))
        payload = json.dumps({'model': 'melo-ui-fixture', 'choices':[{'message':{'role':'assistant','content':answer},'finish_reason':'stop'}]}).encode() if allowed else b'{}'
        self.send_response(200 if allowed else 401)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

def certificate(folder):
    cfg = folder/'tls.cnf'
    cfg.write_text('[req]\ndistinguished_name=dn\nprompt=no\n[dn]\nCN=Melo local UI test\n[ca]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n[server]\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:127.0.0.1\n')
    def ssl_cmd(*args):
        cmd('openssl', *args, stderr=subprocess.DEVNULL)
    ssl_cmd('req','-x509','-newkey','rsa:2048','-nodes','-sha256','-days','2','-config',cfg,'-extensions','ca','-keyout',folder/'ca.key','-out',folder/'ca.crt')
    ssl_cmd('req','-new','-newkey','rsa:2048','-nodes','-sha256','-subj','/CN=127.0.0.1','-keyout',folder/'host.key','-out',folder/'host.csr')
    ssl_cmd('x509','-req','-in',folder/'host.csr','-CA',folder/'ca.crt','-CAkey',folder/'ca.key','-CAcreateserial','-days','1','-sha256','-extfile',cfg,'-extensions','server','-out',folder/'host.crt')

def main():
    evidence = ROOT/'.tmp'/'key-save-ui-results'
    evidence.mkdir(parents=True, exist_ok=True)
    run = Path(tempfile.mkdtemp(prefix='run-',dir=evidence))
    print(run, flush=True)
    runtimes = [r for r in json.loads(sim('list','runtimes','-j'))['runtimes'] if r.get('isAvailable') and '.iOS-' in r['identifier']]
    runtime = max(runtimes, key=lambda r:tuple(map(int,r['version'].split('.'))))['identifier']
    device = sim('create','Melo isolated connection save UI','iPhone 17',runtime)
    try:
        sim('boot',device)
        sim('bootstatus',device,'-b')
        with tempfile.TemporaryDirectory() as tmp, http.server.ThreadingHTTPServer(('127.0.0.1',0),Provider) as server:
            folder = Path(tmp)
            certificate(folder)
            sim('keychain',device,'add-root-cert',folder/'ca.crt')
            tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            tls.load_cert_chain(folder/'host.crt', folder/'host.key')
            server.socket = tls.wrap_socket(server.socket, server_side=True)
            server.receipts = []
            thread = threading.Thread(target=server.serve_forever,daemon=True)
            thread.start()
            try:
                url = 'https://127.0.0.1:'+str(server.server_port)+'/v1'
                args = ['xcodebuild','-project','ios/Melo.xcodeproj','-scheme','MeloConnectionUITests','-configuration','Debug','-destination','id='+device,'-parallel-testing-enabled','NO','-collect-test-diagnostics','never','-resultBundlePath',str(run/'test.xcresult'),'CODE_SIGN_IDENTITY=-','test']
                if os.environ.get('MELO_UI_DERIVED_DATA'):
                    args[1:1] = ['-derivedDataPath',os.environ['MELO_UI_DERIVED_DATA']]
                with (run/'xcode.log').open('w') as log:
                    result = subprocess.run(args,cwd=ROOT,env={**os.environ,'TEST_RUNNER_MELO_CONNECTION_QA_URL':url},stdout=log,stderr=subprocess.STDOUT,timeout=600)
                (run/'receipts.json').write_text(json.dumps(server.receipts)+'\n')
                result.check_returncode()
                assert {k for k,ok in server.receipts if ok} == {'probe','chat'} and all(ok for _,ok in server.receipts), server.receipts
                print('Native UI saved and reopened. The provider accepted the saved credential for the probe and the chat.',flush=True)
            finally:
                server.shutdown()
                thread.join()
    finally:
        subprocess.run(['xcrun','simctl','shutdown',device],stdout=subprocess.DEVNULL)
        sim('delete',device)

if __name__ == '__main__':
    main()
