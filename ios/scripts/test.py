#!/usr/bin/env python3
"""Offline regression gate; all responses are fixtures, no account/device access."""
from pathlib import Path
import hashlib, json, platform, subprocess, sys, time
from swift_test_cache import cached_suite
root=Path(__file__).resolve().parents[2]
subprocess.run(['node','--test','ios/Tests/SceneBridge.test.js','ios/Tests/NeuralLayout.test.js'],cwd=root,check=True)
manifest=json.loads((root/'ios/Melo/Scene/desktop-manifest.json').read_text())
for name,expected in manifest.items():
    assert hashlib.sha256((root/name).read_bytes()).hexdigest()==expected, name+' changed; run npm run build:ios-scene'
print('Desktop renderer bundle is current',flush=True)
if '--renderer-only' in sys.argv:
    print('Renderer-only selection; Swift suites are covered by npm run test:full')
    raise SystemExit(0)
if platform.system() != 'Darwin':
    print('Swift iOS protocol tests require macOS; JS/renderer gate passed; Swift explicitly skipped')
    raise SystemExit(0)
shared=['ios/Melo/ImageWorkflow.swift','ios/Melo/ImageLibrary.swift','ios/Melo/ImageNetwork.swift','ios/Melo/Network.swift','ios/Melo/Models.swift','ios/Melo/ConversationHistory.swift','ios/Melo/WebSources.swift','ios/Melo/ExecutionRecord.swift','ios/Melo/ChatGPTProtocol.swift','ios/Melo/DeviceTools.swift']
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
suites['CodexOAuthTests']=shared+['ios/Melo/CodexOAuth.swift','ios/Melo/ChatGPTAccount.swift','ios/Melo/Keychain.swift']
suites['ConversationHistoryTests']=['ios/Melo/Models.swift','ios/Melo/ConversationHistory.swift']
suites['InterfaceLanguageTests']=['ios/Melo/InterfaceLanguage.swift']
suites['DeviceToolsTests']=shared
suites['SharedContractTests']=shared+['ios/Melo/AgentProfile.swift','ios/Melo/AgentTeam.swift']  # reads shared/protocol/contracts.json, same as the JS half
suites['AgentTeamTests']=shared+['ios/Melo/AgentProfile.swift','ios/Melo/AgentTeam.swift']
suites['LocalFileAccessTests']=['ios/Melo/LocalFileAccess.swift']
suites['ImagePhotoSaveTests']=['ios/Melo/ImagePhotoSave.swift']
toolchain = [platform.machine()]
swift_started = time.monotonic()
cached = 0
for command in [['xcrun','--find','swiftc'], ['xcrun','swiftc','--version'],
                ['xcrun','--show-sdk-path'], ['xcrun','--show-sdk-build-version']]:
    toolchain.append(subprocess.check_output(command, text=True).strip())
for name, sources in suites.items():
    if name in ['EditDraftTests','EditDraftStorageTests','AgentEditTests']: sources = sources + ['ios/Melo/DraftMerge.swift']
    if 'ios/Melo/Models.swift' in sources: sources = sources + ['ios/Melo/SyncWorkspace.swift','ios/Melo/MemoryFacts.swift']
    cached += cached_suite(root, root/'.tmp/ios-test-cache', name, sources+['ios/Tests/'+name+'.swift'],
                           toolchain, ['xcrun','swiftc'])
print(f'All {len(suites)} Swift suites passed; {cached} cached compilations; {time.monotonic()-swift_started:.2f}s',flush=True)
