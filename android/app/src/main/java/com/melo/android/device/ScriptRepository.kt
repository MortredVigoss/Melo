package com.melo.android.device

import com.melo.android.data.*

/** Local-only document fields; Snapshot/mobile-sync deliberately has no script field. */
suspend fun Repository.invalidateDeviceScript(script: DeviceScript, error: String = "") = change { state ->
    state.copy(deviceScripts = state.deviceScripts.map { current ->
        if (current.id != script.id || current.revision != script.revision) current
        else current.copy(hits = current.hits + 1, failures = current.failures + 1, invalidated = true, lastError = error.take(300), updatedAt = now())
    })
}

suspend fun Repository.editDeviceScript(original: DeviceScript, edited: DeviceScript) {
    ScriptValidator.validate(edited)
    change { state ->
        val current = state.deviceScripts.firstOrNull { it.id == original.id } ?: error("此缓存已删除。")
        require(current.revision == original.revision) { "缓存已被修改，请重新打开编辑器。" }
        state.copy(deviceScripts = state.deviceScripts.map {
            if (it.id != original.id) it else edited.copy(id = current.id, scope = current.scope, sourceRunId = current.sourceRunId, revision = current.revision + 1,
                verified = false, invalidated = false, createdAt = current.createdAt, updatedAt = now(), hits = current.hits, successes = current.successes, failures = current.failures, lastError = "")
        })
    }
}

suspend fun Repository.deleteDeviceScript(id: String) = change { it.copy(deviceScripts = it.deviceScripts.filterNot { script -> script.id == id }) }

/** Receipt and trusted cache are one Room-document transaction, including late cancellation. */
suspend fun Repository.commitDeviceOutcome(run: DeviceRun, learned: DeviceScript?, initial: List<DeviceScript>, replaySuccess: DeviceScript?): DeviceRun {
    var finished = run
    change { state ->
        val owner = run.taskContext?.chatId
        require(owner == null || state.chats.any { it.id == owner }) { "关联对话已删除，未发布操作缓存。" }
        require(run.status != "achieved" || run.verification == "visible_facts") { "缺少完成校验，不能发布可信缓存。" }
        var scripts = state.deviceScripts
        if (run.status == "achieved" && replaySuccess != null) {
            val current = scripts.firstOrNull { it.id == replaySuccess.id && it.revision == replaySuccess.revision }
            if (current != null) {
                scripts = scripts.map { if (it.id != current.id) it else it.copy(hits = it.hits + 1, successes = it.successes + 1, verified = true, invalidated = false, environment = it.environment ?: replaySuccess.environment, lastError = "", updatedAt = now()) }
                finished = finished.copy(cacheId = current.id)
            } else finished = finished.copy(cacheNote = "本次运行使用旧版本；当前缓存已修改或删除，未覆盖。")
        }
        if (run.status == "achieved" && learned != null) {
            ScriptValidator.validate(learned)
            fun sameGoal(other: DeviceScript) = other.scope == learned.scope && other.environment == learned.environment && GoalTemplate.normalize(other.goalTemplate) == GoalTemplate.normalize(learned.goalTemplate)
            val expected = initial.firstOrNull(::sameGoal)
            val current = scripts.firstOrNull(::sameGoal)
            if (current?.id == expected?.id && current?.revision == expected?.revision && (current != null || scripts.size < 100)) {
                val published = learned.copy(id = current?.id ?: learned.id, name = current?.name ?: learned.name, revision = (current?.revision ?: 0) + 1,
                    createdAt = current?.createdAt ?: learned.createdAt, updatedAt = now(), verified = true, invalidated = false,
                    hits = current?.hits ?: 0, successes = (current?.successes ?: 0) + 1, failures = current?.failures ?: 0, lastError = "")
                scripts = scripts.filterNot { it.id == published.id } + published
                finished = finished.copy(cacheId = published.id, cacheNote = if (run.executionMode == "similar") "相似脚本已验证并写入 Cache。" else "Probe 已验证成功并自动写入操作 Cache。")
            } else finished = finished.copy(cacheNote = "任务成功；缓存已被修改 / 删除或达到上限，未覆盖现有条目。")
        }
        state.copy(deviceScripts = scripts, deviceRuns = state.deviceRuns.map { if (it.id == finished.id) finished else it })
    }
    return finished
}
