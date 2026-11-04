# Recent-session Harness audit — 2026-10-28

## Scope and evidence

The user asked to read the latest three or four conversations completely and identify systemic improvements before making individual fixes. The phone would be taken away. This audit therefore uses two read-only local snapshots, without stopping the phone App, navigating its UI, changing settings, or sending model requests. No further phone connection is needed for this analysis.

- Four latest conversations, selected using the maximum of message/run/chat activity timestamps: **34 complete messages, 18 root executions, 9 device executions**. Main topics: music search, saved-place navigation, feedback about execution/cache, public recommendations followed by navigation, and creator/video lookup. Two older conversations contain provider failures.
- Both local SQLite copies pass `quick_check` and contain the same state payload hash. Private snapshots, conversation text, addresses, following information, credentials and raw Trace artifacts remain in the ignored Windows `work/phone-session-audit-20261028-005345/` directory. This document uses anonymized examples and short execution IDs; it does not embed the private data.
- The newest **15 root executions ran 0.10.6 / code 30**; the other three ran 0.10.4 / code 28. The recorded model remained `gpt-6.1-sol` through the existing Modal connection. Earlier Bedrock Emulator successes do not validate that provider path.
- Local Trace records contain **27 root + 79 child provider requests** across all 18 executions. Fifteen 0.10.6 executions account for 82 of those requests. These are heterogeneous debug cases, not a statistical success rate or latency benchmark.
- The first model request in each of the 18 root executions includes the registered 13-tool catalog; separate completion-review requests intentionally have no tools. Several runs have complete text Trace but `multimodal=unavailable`; screenshot interpretations cannot be independently verified from missing pixels. UI-tree facts and source branches below are independently inspectable.

This is an audit and change plan. Runtime code was not modified in this stage. The diagnostic script reproduces existing faults; it is not a green acceptance test.

## 1. Intent, policy and completion disagree

### Confirmed: a feedback sentence is treated as an action

Execution `e26ee2cc`: the user reports that navigation is already running and the agent is still looking. The model responds appropriately without issuing a new tool call, but the turn ends `blocked / MISSING_TOOL_EVIDENCE`. The request planner saw navigation vocabulary and required `phone_use` before it knew whether this turn was feedback, clarification, or a new action.

Execution `e04d0db5` likewise asks for clarification of a noisy place/meal utterance but gets `MISSING_TOOL_EVIDENCE`. A legitimate clarification should be `awaiting_input`, not evidence that a phone operation failed. The next clarification is instead marked `completed`, although the underlying action remains pending. Delivery status and task progress are conflated.

Sources: [search.js](../shared/agent/search.js), [turn.js](../shared/agent/turn.js) (`complete` requires `requiredTools`), [completion.js](../shared/agent/completion.js).

### Confirmed: critique triggers an expensive, unsatisfiable reviewer loop

Execution `7ba49103`: a complaint about cache and stopping behavior takes **108.91 seconds and six model requests, with zero executed tools**. Three completion reviews insist the requested product improvement has not been implemented. The phone agent has no code-editing interface with which to implement that improvement. The final honest capability explanation is still labelled blocked.

Execution `22433a3d`: the reviewer explicitly says this turn is feedback/communication and no tool is required. Its verdict is nevertheless downgraded to `GOAL_COVERAGE_MISSING`, because every satisfied requirement must cite an executed tool observation.

There is also an evidence visibility gap: the responding model sees the current Skill Manifest, but `goalReviewRequest` supplies the reviewer tool names and executed observations, not that catalog snapshot. It cannot verify correct statements about available workflows without seeing their actual source. The fix must distinguish evidence for a capability claim from evidence for a completed external action; it must not allow an unsupported "message sent" claim to pass as conversation.

Sources: [goal.js](../shared/agent/goal.js), especially `goalCandidate`, `goalReviewRequest`, `reviewGoal`; [SharedChatAgent.kt](../android/app/src/main/java/com/melo/android/chat/SharedChatAgent.kt), `next` and `checkCandidate`.

### Confirmed in the actual request: conflicting public-research instructions

Execution `efe41cb4`: after the user confirms the intended area and brunch request, the model takes over Maps and performs no Web Search. The actual provider payload contains both:

- Android Skill: `For restaurant recommendations research current sources on the phone`.
- Shared Chat instructions: `Use web tools for public research`.

The root then adds a read-only navigation restriction to its delegated research goal. The child stops at the previous route instead of researching and continuing the new task. That restriction was generated by the model, not a new restriction from the user.

This is live contradictory policy, not just an unused string in the repository. [ChatPhoneUse.kt](../android/app/src/main/java/com/melo/android/chat/ChatPhoneUse.kt) lines 24–27 remain an Android-specific behavior policy appended by [SharedChatAgent.kt](../android/app/src/main/java/com/melo/android/chat/SharedChatAgent.kt).

### Change direction

- Use a shared structured turn/task state that distinguishes `act`, `answer`, `feedback`, `clarify`, `resume`, `cancel`. Recognized words can suggest tools; a hint cannot require an external effect merely to answer feedback or ask a necessary question.
- Preserve a normalized active user goal across confirmation and noisy follow-ups. Keep the raw utterance, resolved entities, user confirmation, active task revision, and constraint provenance. Previous model-authored restrictions must not silently become permanent user policy.
- Consolidate Skill/Tool behavior policy in shared Core. Kotlin/Swift/Node hosts supply actual capabilities, permissions and effects. Public research chooses web tools unless the user requests an App/source or an actual information gap requires it; do not hardcode source counts or a mandatory first search for every turn.
- Give each requirement a claim kind and evidence rules: conversational delivery, capability description, public fact, observed device state, or applied external effect. A host catalog can support a capability claim; only valid execution evidence can support an effect claim.

## 2. Two model loops lose state and keep acting after the desired transition

Current production path:

`SharedChatAgent → phone_use(goal text) → DeviceTaskLoop → repeated model/device calls → one coarse receipt → root finish`

The shared reducer/budget does not by itself unify the goal, observations, completed effects and context owned by those two loops. `phone_use` delegates a newly worded task; the child mostly sees that task and recent device receipts, not the root's full structured task/evidence state.

### Confirmed: navigation continues after Start and attempts to close navigation

Execution `37f6cfcd`, child `858cbefc`, 0.10.6:

1. Select the saved private home destination; the UI Tree contains its saved-place label.
2. Tap **Start**; the next receipt shows a navigation time.
3. Continue tapping the road list and route, then observing again.
4. Attempt to tap **Close navigation**. The native freshness check rejects this tap with `stale_screen`; it did not execute.
5. Observe Melo and reopen Maps; the user ultimately stops the task. The root reports an undifferentiated failure.

There are **six further native dispatches after Start**. The complete root execution takes **83.62 seconds / 12 model requests**. The attempted close was not needed for the original user task. Retain freshness checks: weakening them would make this failure worse.

The child's **fourth** recorded model request contains the saved-home label. It is already absent from the **fifth** request immediately after Start, and remains absent thereafter. [DeviceContextBudget.kt](../android/app/src/main/java/com/melo/android/device/DeviceContextBudget.kt) both drops old call pairs and condenses earlier observation bodies on every round; [DeviceTaskLoop.kt](../android/app/src/main/java/com/melo/android/device/DeviceTaskLoop.kt) calls it unconditionally. The evidence loss is not triggered by filling a 160,000-token model window.

This timing strongly supports lost destination evidence as a contributor to the rechecking. The text Trace proves the loss and subsequent actions; it does not reveal private model reasoning or all visual details.

Execution `3f6085fe` separately reaches a `needs_user` result saying navigation is running but its destination is not currently visible. The parent converts it to `blocked / PHONE_TASK_FAILED`. A running route with an unverified destination must not be reported as verified home navigation; it also should not induce endless rechecking or be collapsed into the same state as an API error.

### Confirmed: effect dispatch and observation failure are merged

In creator lookup child `e1becd27`, a Back action returns `execution_error` because the subsequent window content cannot be read. The next observation succeeds on the new screen. In [MeloAccessibilityService.kt](../android/app/src/main/java/com/melo/android/device/MeloAccessibilityService.kt), Back/Home dispatch, post-action waiting and `observe()` share one `try/catch`; a post-dispatch capture failure returns a generic failed tool result with no reliable applied-effect field.

That structure can misclassify an applied action as "not done", and it prevents both safe recovery and independent cache learning. The source-level defect is confirmed; not every `execution_error` in this dataset proves the same action reached the App.

### Change direction

- Give the task one owner and one evidence/effect ledger. Retain confirmed destination, selected travel mode, applied actions, current goal revision and pending uncertainty independently of removable UI dumps.
- Verify a state sequence, for example:

  `destination resolved and selected → Start applied → navigation active → goal satisfied → stop dispatch`

  The destination does not have to remain printed on the last frame if its earlier selection is still valid and tied to this task. Conversely, "some navigation is active" alone does not prove the requested destination or travel mode.
- Stop before another action once the goal is met. A changing ETA, countdown or animated screen is not progress toward an already completed task. Guard semantic goal/effect progress, not just changing full-screen fingerprints and ephemeral node IDs.
- Separate `effect_not_started`, `effect_applied`, `effect_uncertain`, `observation_unavailable`, user cancellation and provider failure. After an applied effect with missing observation, recover by bounded read/observe; do not automatically repeat the effect. A true user cancellation still stops execution.
- Make context compaction budget-driven. Drop stale images/UI details when needed while retaining the task facts and effect ledger. Keep the host wire/memory cap separate from provider context capacity.
- Move fine-grained device operations into the same main decision loop; keep native workflow replay as a bounded executor without a nested model loop. Preserve native permission, screen identity, layout and target validation.

Target path:

`Shared Core task state → model chooses next action/workflow → native host → typed effect + observation → same task state`

## 3. Cache and entity resolution do not represent reusable intent

### Confirmed: only App opening is reused for Maps

Execution `ba3daa56` does invoke `phone_workflow`: Maps opening completes in **2.30 seconds**, and the device execution has zero model requests. The subsequent destination task still probes from scratch. Cache is present, but the reusable navigation subflows are absent.

The selected nine child executions contain **zero `checkpoint` actions**. [VerifiedScriptPublisher.kt](../android/app/src/main/java/com/melo/android/device/VerifiedScriptPublisher.kt) automatically publishes `open_app`; other independently verified subflows require that checkpoint. A cancelled or `needs_user` navigation task therefore preserves App opening but not an uncheckpointed, otherwise useful search-entry/selection segment. [ScriptRecorder.kt](../android/app/src/main/java/com/melo/android/device/ScriptRecorder.kt) can also permanently reject the segment after an ambiguous action failure.

Root-generated goal paragraphs differ between requests with the same user intent. [DeviceAgent.kt](../android/app/src/main/java/com/melo/android/device/DeviceAgent.kt) passes those paragraphs to the task cache router, while the main `phone_workflow` manifest exposes the saved capabilities. Long wording and partial task boundaries are poor cache identities.

### Confirmed recipe defect: a saved search depends on residual input

The successful music search saves a task recipe containing only:

`open_app → wait → submit_input`

It has **no type_text step, no parameter, and no recorded precondition asserting the existing input value**. It worked after an earlier failed attempt had already populated the App input. The final assertion contains that particular query. This is a state-dependent resume segment labelled as a reusable task; a different initial input could be submitted before the final check rejects it. The recipe/source defect is confirmed, but that incorrect physical replay was not executed during this audit.

The previous Chrome benchmark verified some reusable workflows. It did not cover this resume-state defect, cumulative navigation evidence, conversational feedback or saved-place resolution. Those are gaps in the prior acceptance scope.

### Confirmed: personal references and noisy names are flattened into strings

For "work/company", the model is explicitly asked to use a saved work location, but edits the route destination and types the literal company word. It then asks the user because the public search has several matches. A search result ambiguity does not establish that no saved work shortcut exists.

For creator lookup, the initial App screen already contains a relevant creator. Later the App explicitly corrects the noisy query to the likely name. The agent still ends by treating the literal spelling and the likely creator as unresolved alternatives. This takes **120.55 seconds / 17 total model requests**. Missing screenshot pixels limit diagnosis of the intermediate blank profile page; the initial creator text and later App correction are present in the UI Tree.

The improvement is a general entity-resolution and risk policy, not a fixed company-word substitution. A private saved place needs a reliable binding; inspecting a likely public creator is a reversible read that can be used to resolve ambiguity before asking the user.

### Change direction

- Cache typed capabilities/subflows with explicit `preconditions`, parameter bindings, `effects` and `postconditions`. Separate a whole task from a resume segment. Do not infer a complete reusable search from an existing field value.
- Publish verified segments at real state transitions, independently of the final task outcome, while preserving evidence and environment compatibility. Keep one `phone_workflow` tool plus a shared Skill Manifest as already approved.
- Match semantic intent and arguments, such as `app.search(query)` or `navigate(destinationRef, travelMode)`. Resolve short names, personal roles and aliases to grounded references before converting them into literal UI input. Store provenance and user scope; do not hardcode private addresses or blindly select the most popular result.
- Keep fold/posture/App-version guards for executable selectors. Reuse semantic knowledge separately from geometry-bound targets. Do not improve hit rate by disabling compatibility checks.
- Expose learning status and skipped reasons in structured receipts, so the responding model can accurately explain which segment was learned and which remains unavailable. The current parent receipt lacks that information.

## Provider and UI status are a separate failure axis

The older food and music conversations fail with **429, 502 and 503**. They ran 0.10.4 through the Modal connection, not the later Bedrock Emulator path. Those errors do not establish a navigation-policy defect, and an HTTP 429 alone does not tell us whether the cause was a rate limit or quota.

The food conversation has a user message and failed Run but no assistant message explaining the failure. Distinguish provider/network failure, failed observation, real need for user input, cancellation and goal completion in persisted/UI status. Preserve partial progress and use bounded transport recovery; do not replay prior UI effects because a later model request failed.

## Implementation sequence and acceptance

### First: shared task, policy and evidence contract

Consolidate turn meaning, current goal/constraints, claim kinds, evidence sources and completion status in shared Core. Fix feedback/clarification behavior and register host catalog evidence. Make Skill guidance a single shared source. Preserve capability/user-permission boundaries. Add cross-host contract tests before moving production entry points.

### Second: one decision loop and typed native receipts

Move mobile leaf operations into the main loop with shared task state, cumulative evidence and applied-effect accounting. Keep native adapters responsible for execution/freshness/permissions and workflow replay. Apply context fitting against actual budgets. Do not combine moving code with unrelated simplification: follow the repository's staged migration protocol.

### Third: transition-based learning and behavior evaluation

Use these local records as debug seeds, then create anonymized, independent scenario fixtures and Emulator tasks. Do not commit raw private conversations or treat deterministic Trace replay as proof a fresh model can solve the task.

Acceptance scenarios must cover:

1. Feedback and a necessary clarification require no unrelated external action; no false `MISSING_TOOL_EVIDENCE`, no repeated reviewer loop.
2. A confirmed follow-up retains the researched subject/area and current authorization; old model-generated restrictions expire with their scope.
3. Selected destination + applied Start + verified navigation state stops further dispatch. A changing ETA, PiP transition, keyboard or fold change does not erase confirmed task facts or authorize an unrelated closing action. Unknown pre-existing destinations remain explicitly unverified.
4. Saved personal roles are resolved before public text search; public-name correction is usable evidence for bounded reversible exploration.
5. A successful segment remains learnable when a later independent segment fails. A query-in-residual-input recipe cannot execute as a complete parameterized search.
6. Same-intent repeats and parameter changes are measured from equivalent initial states, with actual provider request counts and independent final UI checks. A failed precondition does not submit stale data or restart already applied effects.
7. Provider errors and post-effect observation failures retain their true stage and recover without duplicate side effects. User cancellation is honored.

Run common fixtures in Node and the Android/iOS Core bridges; validate host-specific execution in controlled Emulator apps and public-browser tasks. Real Maps saved locations, real creator profiles and missing screenshot interpretations require separate device/account validation later. macOS/iPhone runtime behavior was not retested in this audit.

## Local reproduction and boundaries

`.tmp/session-audit-20261028/reproduce.mjs` calls the current shared planner/reducer/reviewer locally, without a model or network. It reproduces three existing faults: navigation feedback blocked for missing phone evidence, clarification blocked for the same reason, and feedback reviewer completion downgraded for lacking tool evidence. The output is `.tmp/session-audit-20261028/reproduction-results.json`.

The raw snapshots and selected chronological evidence stay local. Only required, scoped task facts should become future model context; raw Trace files are not a prompt/history/sync channel. No production code, phone setting, credential, branch publication or PR was changed by this audit.
