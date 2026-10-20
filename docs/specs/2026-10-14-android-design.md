# Melo Android — confirmed native direction

The user selected Kotlin + Jetpack Compose, prioritising Samsung, and explicitly selected in-app credentials with fixture-only development on 2026-10-14. This document makes that accepted direction concrete; it does not authorise live provider requests or credential creation.

## Product and boundaries

Add an independent Android application under `android/`, keeping the existing desktop and iOS applications intact. Use the iOS client and shared mobile protocol at `f0438bd3567edf4df1248b2b446ce06214c3f272` as the behavioural reference. Reuse the checked-in neural/execution renderer and shared protocol schema rather than forking their implementations. Desktop shell, filesystem execution and the full desktop memory engine remain desktop capabilities, as in the existing iOS client.

Deliver independent multi-turn chat, connection/model settings, cancel/retry and interrupted-turn recovery; persisted conversations, drafts, agents and workspace context; optional existing mobile-sync integration; speech/image and task-history entry points backed by actual behaviour. The app must report errors and capability limits, preserve user input, and never present a fixture reply as a live provider result.

## Architecture

Compose UI -> ViewModel -> repository / HTTP client -> Room + device-local Keystore / selected HTTPS provider and optional sync endpoint.

Use immutable state and serialized repository mutations. Persist a user turn before starting a request and an assistant turn only on verified completion. Cancellation closes the underlying request; partial output remains distinguishable from a completed answer. Process death preserves the prompt and marks the attempt interrupted, allowing explicit retry without duplicate user messages.

Use Android Keystore-backed AES-GCM for credentials. Credentials never enter a sync snapshot, export, log or WebView. Production endpoints require HTTPS, reject embedded credentials/fragments and do not follow authenticated redirects. Development fixtures are restricted to debug builds and explicit local hosts.

Validate the existing JSON schema and semantic merge rules before accepting sync data. Retain deletion tombstones, require deletion acknowledgements, preserve concurrent workspace versions, and do not overwrite local state on network/validation/conflict failure. Preserve the 8 MiB wire budget.

## Platform and UI

Build against the current stable Android toolchain, target API 36 for Android 16 / One UI 8.5, and keep minSdk 28. Use Compose edge-to-edge insets and IME handling, predictive-back-aware navigation, resizable layouts and system document/photo pickers. Reuse Melo's black/gold tokens and bundled neural scene through an origin-restricted local WebView bridge, pausing graphics when hidden.

Background requests use an appropriate Android foreground service only while actual work is active, with a visible cancel action. Requests and partial output survive Activity recreation. System termination is recorded as interruption; no claim of unrestricted background lifetime is made.

## Verification and acceptance

1. JVM tests exercise request/stream completion and failure, URL policy, cancellation, shared schema fixtures, deletion/concurrent merge and recovery semantics using fixtures.
2. Assemble an installable debug APK, run Android lint, inspect manifest/signature and verify the APK does not contain unverified native `.so` dependencies.
3. Android 16 runtime checks cover install/start, native navigation, keyboard, fixture chat, persistence, cancel/retry, configuration and background recovery, sync and renderer bridge.
4. Samsung One UI 8.5 device checks cover the same user flows, permissions, gestures and background behaviour. Record device model/build and logs. Android emulator checks cannot stand in for Samsung-specific verification; this acceptance item remains pending until a suitable device is accessible.

## Implementation order

Build and platform shell -> persistence and protocol -> providers/streaming -> state and recovery -> native UI and shared scenes -> media/speech/workspace integration -> automated and device verification -> APK and evidence delivery.
