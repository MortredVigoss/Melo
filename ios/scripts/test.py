#!/usr/bin/env python3
"""Offline regression gate; all responses are fixtures, no account/device access."""
from pathlib import Path
import argparse, concurrent.futures, hashlib, json, os, platform, subprocess, tempfile, time
from swift_test_cache import prepare_suite
root=Path(__file__).resolve().parents[2]

shared=['ios/Melo/ImageWorkflow.swift','ios/Melo/ImageLibrary.swift','ios/Melo/ImageNetwork.swift','ios/Melo/Network.swift','ios/Melo/ModelStream.swift','ios/Melo/Models.swift','ios/Melo/ConversationHistory.swift','ios/Melo/PhoneContext.swift','ios/Melo/WebSources.swift','ios/Melo/ExecutionRecord.swift','ios/Melo/ChatGPTProtocol.swift','ios/Melo/DeviceTools.swift','ios/Melo/WebPageText.swift','ios/Melo/ImageContext.swift','ios/Melo/RunProgress.swift','ios/Melo/AgentLoopContract.swift','ios/Melo/CapabilityElevation.swift','ios/Melo/AgentLoopRuntime.swift','ios/Melo/AgentLoop.swift','ios/Melo/SharedAgentCore.swift','ios/Melo/LoopTrace.swift']
suites={'main':['ios/Melo/Models.swift'], 'NetworkTests':shared, 'ConnectionProbeTests':['ios/Melo/ConnectionProbe.swift'], 'ChatGPTTests':shared, 'SSETransportTests':shared, 'WebSearchTests':shared, 'ExecutionTests':shared, 'ExecutionPageTests':['ios/Melo/ExecutionPagePolicy.swift']}
suites['ModelStreamTests']=shared
suites['ReplyLatencyTests']=shared
suites['ConversationFoundationTests']=shared+['ios/Melo/AgentProfile.swift','ios/Melo/ReplyDocument.swift','ios/Melo/WorkspaceProjection.swift']
suites['SyncContractTests']=['ios/Melo/Models.swift']
suites['MemoryFactsTests']=['ios/Melo/Models.swift']
suites['EditDraftTests']=['ios/Melo/EditDraft.swift']
suites['EditDraftStorageTests']=['ios/Melo/EditDraft.swift','ios/Melo/EditDraftStorage.swift']
suites['AgentEditTests']=shared+['ios/Melo/AgentProfile.swift','ios/Melo/AgentEditSession.swift']
suites['LifecycleJournalTests']=['ios/Melo/Models.swift','ios/Melo/LifecycleJournal.swift']
suites['VoiceInputTests']=['ios/Melo/VoiceInput.swift']
suites['VoiceCallTests']=['ios/Melo/VoiceCall.swift','ios/Melo/VoiceTurnRules.swift','ios/Melo/SpeechText.swift','ios/Melo/AgentLoopContract.swift']  # live voice call: turn-taking engine + rules against fixtures.voiceTurn (reads shared/protocol/agent-loop.json)
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
suites['SharedAgentCoreTests']=['ios/Melo/SharedAgentCore.swift','ios/Melo/LoopTrace.swift']
suites['LoopTraceTests']=['ios/Melo/SharedAgentCore.swift','ios/Melo/LoopTrace.swift']
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

def compile_jobs():
    # Leave two cores to the rest of the machine; six compilers at once is where memory starts to matter.
    requested = os.environ.get('MELO_SWIFT_COMPILE_JOBS')
    if requested is not None:
        if not requested.isdigit() or int(requested) < 1:
            raise RuntimeError('MELO_SWIFT_COMPILE_JOBS must be a positive integer')
        return int(requested)
    return max(1, min(6, (os.cpu_count() or 2) - 2))

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
    parser.add_argument('--compile-only', action='store_true', help='compile (or reuse) the selected suites and stop; a later call runs them from the cache')
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
    # Compile first, several suites at a time (2026-11-14): one swiftc run uses a
    # single core and most suites compile the same two dozen sources, so compiling
    # them one after another took nine minutes on a cold cache. The tests then run
    # one suite after another in catalog order, exactly as before; nothing about
    # the cache key or the binaries changes.
    logs = {}
    def compile_quietly(name):
        def run(args, **kwargs):
            done = subprocess.run(args, cwd=kwargs.get('cwd'), stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
            logs[name] = done.stdout
            if done.returncode:
                raise subprocess.CalledProcessError(done.returncode, args, output=done.stdout)
        return run
    def compiler(sources):
        return ['xcrun','swiftc'] + (['-D','MELO_TEST'] if 'ios/Melo/SharedAgentCore.swift' in sources else [])
    built = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=compile_jobs()) as pool:
        pending = {name: pool.submit(prepare_suite, root, root/'.tmp/ios-test-cache', name, sources, toolchain, compiler(sources), compile_quietly(name))
                   for name, sources in selected.items()}
        try:
            for name in selected:
                built[name] = pending[name].result()
        except subprocess.CalledProcessError as error:
            for future in pending.values():
                future.cancel()
            print(f'{name}: compilation failed', flush=True)
            print(error.output or '', flush=True)
            raise
    if args.compile_only:
        # The gate compiles beside the Android build and runs the suites afterwards, alone:
        # several of them assert on task timing and must not share the machine with Gradle.
        for name, (binary, hit) in built.items():
            cached += hit
            if logs.get(name):
                print(logs[name], end='' if logs[name].endswith('\n') else '\n', flush=True)
        print(f'{len(selected)} Swift suites ready; {cached} cached compilations; {time.monotonic()-swift_started:.2f}s; not run',flush=True)
        return
    for name, (binary, hit) in built.items():
        cached += hit
        print(f'{name}: {"cached compile" if hit else "compiled"}; running tests', flush=True)
        if logs.get(name):
            print(logs[name], end='' if logs[name].endswith('\n') else '\n', flush=True)
        subprocess.run([str(binary)], cwd=root, check=True)
    print(f'All {len(selected)} Swift suites passed; {cached} cached compilations; {time.monotonic()-swift_started:.2f}s',flush=True)

if __name__ == '__main__':
    with tempfile.TemporaryDirectory(prefix='melo-swift-traces-') as traces:
        os.environ['MELO_TEST_TRACE_DIR'] = traces
        main()
