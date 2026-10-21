#!/usr/bin/env python3
"""Offline regression gate; all responses are fixtures, no account/device access."""
from pathlib import Path
import argparse, hashlib, json, platform, subprocess, time
from swift_test_cache import cached_suite
root=Path(__file__).resolve().parents[2]

shared=['ios/Melo/ImageWorkflow.swift','ios/Melo/ImageLibrary.swift','ios/Melo/ImageNetwork.swift','ios/Melo/Network.swift','ios/Melo/Models.swift','ios/Melo/ConversationHistory.swift','ios/Melo/PhoneContext.swift','ios/Melo/WebSources.swift','ios/Melo/ExecutionRecord.swift','ios/Melo/ChatGPTProtocol.swift','ios/Melo/DeviceTools.swift','ios/Melo/WebPageText.swift','ios/Melo/ImageContext.swift','ios/Melo/RunProgress.swift','ios/Melo/AgentLoopContract.swift','ios/Melo/CapabilityElevation.swift','ios/Melo/AgentLoopRuntime.swift','ios/Melo/AgentLoop.swift','ios/Melo/SharedAgentCore.swift']
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
suites['ConversationHistoryTests']=shared
suites['SpeechTextTests']=['ios/Melo/SpeechText.swift']
suites['InterfaceLanguageTests']=['ios/Melo/InterfaceLanguage.swift']
suites['DeviceToolsTests']=shared
suites['SharedContractTests']=shared+['ios/Melo/AgentProfile.swift','ios/Melo/AgentTeam.swift']  # reads shared/protocol/contracts.json, same as the JS half
suites['AgentTeamTests']=shared+['ios/Melo/AgentProfile.swift','ios/Melo/AgentTeam.swift']
suites['VideoStudyTests']=shared+['ios/Melo/AgentProfile.swift','ios/Melo/VideoStudy.swift']
suites['RunProgressTests']=shared
suites['LocalFileAccessTests']=['ios/Melo/LocalFileAccess.swift']
suites['SharedAgentCoreTests']=['ios/Melo/SharedAgentCore.swift']
suites['SharedPolicyUnavailableTests']=shared+['ios/Melo/AgentProfile.swift','ios/Melo/AgentTeam.swift']
suites['ImagePhotoSaveTests']=['ios/Melo/ImagePhotoSave.swift']
suites['PhoneTurnContextTests']=shared+['ios/Melo/PhoneTurnContext.swift']
suites['TopicDividersTests']=shared+['ios/Melo/TopicDividers.swift']
suites['WebPageToolsTests']=shared  # WebPageTools.swift needs WebKit/UIKit; only the pure half (WebPageText.swift, envelope in AgentLoopRuntime.swift) compiles here
suites['AgentLoopTests']=shared+['ios/Melo/AgentProfile.swift','ios/Melo/AgentTeam.swift']  # AgentLoop with a fake transport: limits, budget, guard, supplements, condensation, trace, finalize
suites['ParityRegressionTests']=shared+['ios/Melo/AgentProfile.swift','ios/Melo/AgentTeam.swift','ios/Melo/WorkspaceProjection.swift']
suites['CapabilityElevationTests']=shared+['ios/Melo/AgentProfile.swift','ios/Melo/AgentTeam.swift','ios/Melo/CapabilityElevationRuntime.swift','ios/Melo/AgentStarter.swift']  # phone decision table, device-local ledger, broker (cards, collapse, timeout, revoke), choke point + run record, starter set

# The same manifest feeds execution and daily selection. Never duplicate source
# lists in JavaScript: a new suite must become discoverable automatically.
def suite_sources():
    result = {}
    for name, inputs in suites.items():
        sources = list(inputs)
        if name in ['EditDraftTests','EditDraftStorageTests','AgentEditTests']:
            sources += ['ios/Melo/DraftMerge.swift']
        if 'ios/Melo/Models.swift' in sources:
            sources += ['ios/Melo/SyncWorkspace.swift','ios/Melo/MemoryFacts.swift']
        result[name] = sources + ['ios/Tests/'+name+'.swift']
    return result

def check_agent_core():
    # Generated shared agent core must match its sources (build-agent-core.mjs).
    subprocess.run(['node','scripts/build-agent-core.mjs','--check'],cwd=root,check=True)

def check_renderer():
    manifest=json.loads((root/'ios/Melo/Scene/desktop-manifest.json').read_text())
    for name,expected in manifest.items():
        if hashlib.sha256((root/name).read_bytes()).hexdigest()!=expected:
            raise RuntimeError(name+' changed; run npm run build:ios-scene')
    print('Desktop renderer bundle is current',flush=True)

def main():
    catalog = suite_sources()
    parser = argparse.ArgumentParser()
    parser.add_argument('--suite', action='append', choices=tuple(catalog))
    parser.add_argument('--list-suites', action='store_true')
    parser.add_argument('--renderer-only', action='store_true')
    parser.add_argument('--check-renderer', action='store_true')
    parser.add_argument('--skip-renderer', action='store_true')
    parser.add_argument('--skip-js', action='store_true', help='JS selection/execution is owned by the calling gate')
    args = parser.parse_args()
    if args.list_suites:
        print(json.dumps(catalog, sort_keys=True))
        return
    if args.check_renderer:
        check_renderer()
        return
    if not args.skip_renderer:
        check_renderer()
    if not args.skip_js:
        subprocess.run(['node','--test','ios/Tests/SceneBridge.test.js','ios/Tests/NeuralLayout.test.js'],cwd=root,check=True)
    if args.renderer_only:
        print('Renderer-only selection; no Swift suites requested')
        return
    if platform.system() != 'Darwin':
        print('Swift iOS protocol tests require macOS; Swift explicitly skipped')
        return
    # SharedAgentCore.swift embeds the bundled agent core; a stale bundle would
    # make the Swift suites test old code, so verify it before compiling.
    check_agent_core()
    selected = {name: sources for name, sources in catalog.items() if not args.suite or name in args.suite}
    toolchain = [platform.machine()]
    swift_started = time.monotonic()
    cached = 0
    for command in [['xcrun','--find','swiftc'], ['xcrun','swiftc','--version'],
                    ['xcrun','--show-sdk-path'], ['xcrun','--show-sdk-build-version']]:
        toolchain.append(subprocess.check_output(command, text=True).strip())
    for name, sources in selected.items():
        cached += cached_suite(root, root/'.tmp/ios-test-cache', name, sources, toolchain,
                               ['xcrun','swiftc'] + (['-D','MELO_TEST'] if 'ios/Melo/SharedAgentCore.swift' in sources else []))
    print(f'All {len(selected)} Swift suites passed; {cached} cached compilations; {time.monotonic()-swift_started:.2f}s',flush=True)

if __name__ == '__main__':
    main()
