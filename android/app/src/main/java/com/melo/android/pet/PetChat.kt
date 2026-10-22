package com.melo.android.pet

import com.melo.android.data.AppData
import com.melo.android.data.Conversation
import com.melo.android.data.Repository

/** The pet talks in one dedicated conversation that uses the current default model connection. */
object PetChat {
    const val TITLE = "桌宠"

    /** The stored pet chat when it still exists and is not archived; a deleted or archived one is replaced. */
    fun existing(data: AppData, chatId: String): Conversation? = if (chatId.isBlank()) null else data.chats.find { it.id == chatId && !it.archived }

    /** Finds the stored chat or creates a fresh one; the id is remembered in the pet preferences. */
    suspend fun ensure(repository: Repository, preferences: PetPreferences): String {
        existing(repository.data.value, preferences.value.chatId)?.let { return it.id }
        val id = repository.newChat()
        repository.editChat(id) { it.copy(title = TITLE) }
        preferences.update { it.copy(chatId = id) }
        return id
    }

    /** The engine titles a chat from its first message; restore the fixed title once that has happened. */
    suspend fun keepTitle(repository: Repository, chatId: String) {
        val chat = repository.data.value.chats.find { it.id == chatId } ?: return
        if (chat.messages.size <= 2 && chat.title != TITLE) repository.editChat(chatId) { it.copy(title = TITLE) }
    }
}
