package com.melo.android.data

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import androidx.room.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

@Entity(tableName = "documents") data class StoredDocument(@PrimaryKey val id: String = "state", val payload: String)
@Dao interface DocumentDao {
    @Query("SELECT * FROM documents WHERE id = 'state'") suspend fun load(): StoredDocument?
    @Upsert suspend fun save(document: StoredDocument)
}
@Database(entities = [StoredDocument::class], version = 1, exportSchema = false)
abstract class MeloDatabase : RoomDatabase() {
    abstract fun documents(): DocumentDao
    companion object { fun open(context: Context): MeloDatabase = Room.databaseBuilder(context, MeloDatabase::class.java, "melo.db").build() }
}

/** Only ciphertext is stored in preferences; it never enters AppData or exports. */
class CredentialVault(context: Context) {
    private val preferences = context.getSharedPreferences("melo.credentials", Context.MODE_PRIVATE)
    private val alias = "melo.android.credentials.v1"
    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(alias, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT).setKeySize(256).setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
        }.generateKey()
    }
    @Synchronized fun get(id: String): String {
        val encoded = preferences.getString(id, null) ?: return ""
        val parts = encoded.split(':', limit = 2)
        require(parts.size == 2) { "本机凭证记录无效，请重新填写该连接。" }
        return try {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, Base64.decode(parts[0], Base64.NO_WRAP)))
            String(cipher.doFinal(Base64.decode(parts[1], Base64.NO_WRAP)), Charsets.UTF_8)
        } catch (_: Exception) { throw IllegalStateException("无法解密本机凭证，请重新填写该连接。") }
    }
    @Synchronized fun set(id: String, value: String) {
        if (value.isBlank()) { check(preferences.edit().remove(id).commit()) { "无法移除凭证。" }; return }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key()) }
        val encrypted = cipher.doFinal(value.toByteArray(Charsets.UTF_8))
        val encoded = Base64.encodeToString(cipher.iv, Base64.NO_WRAP) + ":" + Base64.encodeToString(encrypted, Base64.NO_WRAP)
        check(preferences.edit().putString(id, encoded).commit()) { "凭证未保存，请重试。" }
    }
}

class LocalStorage(context: Context) {
    private val database = MeloDatabase.open(context)
    val credentials = CredentialVault(context)
    suspend fun load(): AppData = withContext(Dispatchers.IO) {
        database.documents().load()?.let { MeloJson.decodeFromString<AppData>(it.payload) } ?: AppData()
    }
    suspend fun save(data: AppData) = withContext(Dispatchers.IO) {
        database.documents().save(StoredDocument(payload = MeloJson.encodeToString(data)))
    }
}
