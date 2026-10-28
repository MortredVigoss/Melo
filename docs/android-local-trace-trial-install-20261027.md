# Fold6 0.10.4 local Trace trial installation — 2026-10-27

- User requested latest local trial before continuing Trace implementation.
- APK: `artifacts/Melo-0.10.4-local-trace-trial-debug.apk` in the Windows task workspace.
- SHA256: `fed9e7360b8f3547cff328b417959a45205e959e0c8d66cb7e42f7abc37c5436`.
- Built from current uncommitted Trace WIP over `2bb7ffc`; versionName 0.10.4, versionCode 28. This is a trial, not completed Trace acceptance.
- Rebuilt shared Agent Core and module map before Android build.
- JVM 170/170, shared/Node Trace + actual HTTP integration 12/12, Emulator LoopTraceFlowTest 2/2 passed. Debug and instrumentation APK assembled successfully.
- Fold6 RFCX714K7TR: `adb install -r` returned Success. Existing data was not cleared.
- Package readback: versionName=0.10.4 / versionCode=28. `am start -W` returned Status: ok / COLD / 1788ms; process alive.
- Subsequent screenshot and resumed-activity check showed another app in foreground. No further phone interaction; no claim of visual acceptance or real-model workflow completion.
- Same-scope quick gate completed with two missing-private-pet-asset failures: `.tmp/test-runs/run-85yqsn`, `.tmp/loop-trace-install-scope-gate.log`; JS 4641 / 4624 pass / 2 fail / 15 skip; Android JVM/Lint/Debug/Release passed. iOS native checks need macOS.
- Trace implementation remains WIP. New Trace storage is local and has no upload path; retain local-only requirement, finish isolation/retention checks before declaring the feature complete.
