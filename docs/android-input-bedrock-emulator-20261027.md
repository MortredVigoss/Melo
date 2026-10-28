# Android input submission / Bedrock Emulator verification — 2026-10-27

## Latest Fold6 failure

Read-only snapshot taken before the user asked to stop phone use. The device was not operated after that instruction. Raw phone DB and JSONL remain in the ignored Windows task `work/latest-failure-20261027/`; they are not committed or uploaded.

- 19:27 search: `aa7d2aba-9f6a-4bf7-842c-3622c937be39`, child `913017b5-9fd4-4c4f-8004-858c58e07a4a`. `phone_use` was offered and executed; YouTube Music opened and the Chinese query was entered. The child issued 21 model requests, dispatched 20 steps and ended on HTTP 502. The 19:29 explanation request `4f1a678c-5ae8-419c-9364-2a2f2bdc5b7a` then failed on HTTP 503 before any Tool.
- Actual missing capability: `type_text` only performed ACTION_SET_TEXT. No advertised editor-submission action existed. The task remained on the input page, repeating waits/taps/screenshots.
- Progress defect: capture metadata and optional JPEGs were hashed as page changes despite a usable, unchanged UI tree. This reset the shared reducer's no-progress counter. The reducer itself kept requesting the next model round; this was not a dropped Tool receipt.
- The successful open-app action WAS saved despite the later failure (`learnedScriptIds` has one action). The excluded older entries had incompatible/missing environment records.

## Fixes (0.10.5 / 29, local WIP)

- Register `submit_input(screen_id,node_id)` end to end: schema, validation, Accessibility execution, fresh-node checks, action progress, recorder, validator, planner and native replay. Expose focused / submit_available / submit_label on editable nodes. Search uses current task authorization; other/unknown editor actions retain native confirmation. Unsupported actions return explicit failure; no blind global key injection or implicit text submission.
- Page fingerprint uses observed package/window/geometry/node contents; it excludes capture/launch metadata and runtime IDs. JPEG hashes contribute only where the UI tree is unusable. New red/green regression reproduces screenshot-mode resets; shared Core Native regression stops identical captures after six model rounds.
- Preserve HTTP status and a bounded, credential-redacted Provider error receipt in local Trace.
- A real Bedrock run exposed a further 400: signed thinking blocks survived edits to earlier screenshots/results. Drop all bound thinking blocks when editing the Anthropic history prefix; retain Tool use/result pairs. Keep existing compaction assertions. Two new red tests reproduced both mutations, then passed after the fix.

Official behavior references: [Android ACTION_IME_ENTER](https://developer.android.com/reference/android/view/accessibility/AccessibilityNodeInfo.AccessibilityAction#ACTION_IME_ENTER), [Anthropic thinking troubleshooting](https://platform.claude.com/docs/en/build-with-claude/thinking-troubleshooting).

## Bedrock and live Emulator evidence

User explicitly selected us-west-2 / Opus 5.5 and authorized use of the provided local key file. No credential is embedded in source, APK or this report. The one-time Emulator inbox is deleted before requests; the configured connection uses Android Keystore encryption. Scan of Emulator DB + local Traces found no plaintext copy of that key. Android allowBackup=false; Trace has no upload route.

- Verified HTTP 200 at `https://bedrock-runtime.us-west-2.amazonaws.com/anthropic/v1/messages`, protocol `anthropic`, model `us.anthropic.claude-opus-5-5`; server reports `claude-opus-5-5`. Existing Adapter works without a proxy or new backend. The Mantle bare-model attempt returned 404; it was not used as the final configuration.
- `BedrockDeviceSmokeTest` is opt-in, Emulator-only, uses the production DeviceAgentClient / shared Core / Accessibility executor. Ordinary CI never spends a real key. Exact original assertions remain for blocked cases.
- Chinese input -> focused editor Search submission -> result -> finish: achieved, five actual model requests. After resetting the test Activity, the recorded selector-based script replayed and independently verified its terminal with **zero additional model calls**. Evidence `.tmp/bedrock-cache-final.log` and `.tmp/bedrock-cache-final-result.json`.
- Real Settings App: achieved in ~26s / seven requests; read-only Bluetooth search. Parsed UI evidence independently contains Bluetooth, Bluetooth address, Bluetooth scanning and Settings result paths. The Settings editor returns results while typing and rejects direct submission; those failures remain visible, not counted as successful submissions. Evidence Windows task `work/bedrock-settings-final-native.log` / `work/bedrock-settings-final-result.json`.
- Real YouTube Music: after the history fix, ten model requests completed without signature errors, then NO_PROGRESS stopped the task. The owned Emulator is signed out and exposes Device files / Sign in, no online-search UI. This is a **failed/blocked live acceptance**, not a completed song search. No Google account was added and no login was performed. Evidence `.tmp/bedrock-youtube-final.log`, `.tmp/bedrock-youtube-final-result.json`.
- Initial native broad regression had 15/17 pass: two Settings launch cases inherited the live search's Settings Intelligence task. Isolated the external Settings task in Emulator-only test setup without changing production launch policy or assertions; final isolated rerun passed 17/17. Initial raw result `.tmp/search-submit-final-DeviceAgentTest.log` is retained.

## Current validation and delivery boundary

- JVM 175/175, Debug + instrumentation APK built, Android Lint / R8 Release pass in scoped gate.
- Final Emulator Native rerun: DeviceAgentTest 17/17, SharedDeviceProgressTest 4/4, LoopTraceFlowTest 2/2 (23/23); evidence `.tmp/search-submit-isolated-{Class}.log`. Native input-submission test also passed independently 1/1. Live fixture + native Cache replay passed; live Settings passed; live YouTube Music remains blocked as described.
- Scoped gate `.tmp/test-runs/run-k4B0cc`: JS 4641 / 4623 pass / 3 fail / 15 skip / 0 cancelled. Two failures are missing private desktop-pet assets; Telegram archive server-startup timed out once and its unchanged browser test passed the isolated rerun (1/1, `.tmp/search-submit-telegram-recheck.log`). This is not a fully green repository gate. Earlier run-VP0c5W had only the two asset failures.
- iOS native / JavaScriptCore build remains untested on Linux. Shared Trace retention/global pin quota and isolation work remain WIP; do not describe the whole Trace feature as accepted.
- Exported Windows artifact `artifacts/Melo-0.10.5-input-submit-bedrock-debug.apk`, SHA256 `7cbb76dcb67e0b2a9075b223f2721ed7de09bf10979e54dd58396a46214ac6e2`.
- Installed only on the owned Emulator. Fold6 still has 0.10.4 / its earlier connection: user asked to stop phone use. No push or PR.
