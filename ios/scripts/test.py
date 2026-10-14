#!/usr/bin/env python3
"""Offline regression gate; all responses are fixtures, no account/device access."""
from pathlib import Path
import hashlib, json, platform, subprocess, tempfile
root=Path(__file__).resolve().parents[2]
subprocess.run(['node','--test','ios/Tests/SceneBridge.test.js','ios/Tests/NeuralLayout.test.js'],cwd=root,check=True)
manifest=json.loads((root/'ios/Melo/Scene/desktop-manifest.json').read_text())
for name,expected in manifest.items():
    assert hashlib.sha256((root/name).read_bytes()).hexdigest()==expected, name+' changed; run npm run build:ios-scene'
print('Desktop renderer bundle is current',flush=True)
if platform.system() != 'Darwin':
    print('Swift iOS protocol tests require macOS; JS/renderer gate passed; Swift explicitly skipped')
    raise SystemExit(0)
shared=['ios/Melo/ImageWorkflow.swift','ios/Melo/ImageLibrary.swift','ios/Melo/ImageNetwork.swift','ios/Melo/Network.swift','ios/Melo/Models.swift','ios/Melo/ConversationHistory.swift','ios/Melo/WebSources.swift','ios/Melo/ExecutionRecord.swift','ios/Melo/ChatGPTProtocol.swift']
suites={'main':['ios/Melo/Models.swift'], 'NetworkTests':shared, 'ConnectionProbeTests':['ios/Melo/ConnectionProbe.swift'], 'ChatGPTTests':shared, 'SSETransportTests':shared, 'WebSearchTests':shared, 'ExecutionTests':shared, 'ExecutionPageTests':['ios/Melo/ExecutionPagePolicy.swift']}
suites['ConversationFoundationTests']=shared+['ios/Melo/AgentProfile.swift','ios/Melo/ReplyDocument.swift','ios/Melo/WorkspaceProjection.swift']
suites['SyncContractTests']=['ios/Melo/Models.swift']
suites['MemoryFactsTests']=['ios/Melo/Models.swift']
suites['EditDraftTests']=['ios/Melo/EditDraft.swift']
suites['EditDraftStorageTests']=['ios/Melo/EditDraft.swift','ios/Melo/EditDraftStorage.swift']
suites['AgentEditTests']=shared+['ios/Melo/AgentProfile.swift','ios/Melo/AgentEditSession.swift']
suites['LifecycleJournalTests']=['ios/Melo/Models.swift','ios/Melo/LifecycleJournal.swift']
suites['VoiceInputTests']=['ios/Melo/VoiceInput.swift']
suites['ReplyBackgroundTests']=['ios/Melo/ReplyBackgroundLifetime.swift']
suites['ImageWorkflowTests']=shared
suites['ConversationHistoryTests']=['ios/Melo/Models.swift','ios/Melo/ConversationHistory.swift']
with tempfile.TemporaryDirectory(prefix='melo-ios-tests-') as work:
    for name, sources in suites.items():
        if name in ['EditDraftTests','EditDraftStorageTests','AgentEditTests']: sources = sources + ['ios/Melo/DraftMerge.swift']
        if 'ios/Melo/Models.swift' in sources: sources = sources + ['ios/Melo/SyncWorkspace.swift','ios/Melo/MemoryFacts.swift']
        binary=str(Path(work)/name)
        subprocess.run(['xcrun','swiftc',*sources,'ios/Tests/'+name+'.swift','-o',binary],cwd=root,check=True)
        subprocess.run([binary],cwd=root,check=True)
print(f'All {len(suites)} Swift suites passed',flush=True)
