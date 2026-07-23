package com.panzzpay.forwarder

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.net.URI
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

object SecurePreferences {
    private const val KEYSTORE = "AndroidKeyStore"
    private const val KEY_ALIAS = "panzzpay_webhook_aes_v1"
    private const val PREFS = "PanzzPaySecurePrefs"
    private const val ENCRYPTED_WEBHOOK_URL = "webhook_url_encrypted"
    private const val LEGACY_PREFS = "PanzzPayPrefs"
    private const val LEGACY_WEBHOOK_URL = "webhook_url"

    fun getWebhookUrl(context: Context): String {
        val securePrefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        securePrefs.getString(ENCRYPTED_WEBHOOK_URL, null)?.let { encrypted ->
            return runCatching { decrypt(encrypted) }
                .getOrDefault("")
                .takeIf(::isSecureProvisioningUrl)
                .orEmpty()
        }

        val legacyPrefs = context.getSharedPreferences(LEGACY_PREFS, Context.MODE_PRIVATE)
        val legacyUrl = legacyPrefs.getString(LEGACY_WEBHOOK_URL, null).orEmpty()
        if (legacyUrl.isNotBlank() && putWebhookUrl(context, legacyUrl)) {
            legacyPrefs.edit().remove(LEGACY_WEBHOOK_URL).apply()
            return legacyUrl
        }
        return ""
    }

    fun putWebhookUrl(context: Context, webhookUrl: String): Boolean = runCatching {
        require(isSecureProvisioningUrl(webhookUrl)) { "Invalid provisioning URL" }
        val encrypted = encrypt(webhookUrl)
        val committed = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putString(ENCRYPTED_WEBHOOK_URL, encrypted)
            .commit()
        if (committed) {
            context.getSharedPreferences(LEGACY_PREFS, Context.MODE_PRIVATE)
                .edit()
                .remove(LEGACY_WEBHOOK_URL)
                .apply()
        }
        committed
    }.getOrDefault(false)

    private fun isSecureProvisioningUrl(value: String): Boolean = runCatching {
        val uri = URI(value)
        val token = uri.fragment.orEmpty().split('&')
            .firstOrNull { it.startsWith("token=") }
            ?.substringAfter("token=")
            .orEmpty()
        uri.scheme.equals("https", ignoreCase = true) && !uri.host.isNullOrBlank() && token.length >= 32
    }.getOrDefault(false)

    private fun getOrCreateKey(): SecretKey {
        val keyStore = KeyStore.getInstance(KEYSTORE).apply { load(null) }
        (keyStore.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }

        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE).run {
            init(
                KeyGenParameterSpec.Builder(
                    KEY_ALIAS,
                    KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
                )
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setRandomizedEncryptionRequired(true)
                    .build()
            )
            generateKey()
        }
    }

    private fun encrypt(value: String): String {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey())
        val encrypted = cipher.doFinal(value.toByteArray(Charsets.UTF_8))
        val payload = ByteArray(cipher.iv.size + encrypted.size)
        System.arraycopy(cipher.iv, 0, payload, 0, cipher.iv.size)
        System.arraycopy(encrypted, 0, payload, cipher.iv.size, encrypted.size)
        return Base64.encodeToString(payload, Base64.NO_WRAP)
    }

    private fun decrypt(payload: String): String {
        val bytes = Base64.decode(payload, Base64.NO_WRAP)
        require(bytes.size > 12) { "Invalid encrypted webhook value" }
        val iv = bytes.copyOfRange(0, 12)
        val encrypted = bytes.copyOfRange(12, bytes.size)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, getOrCreateKey(), GCMParameterSpec(128, iv))
        return String(cipher.doFinal(encrypted), Charsets.UTF_8)
    }
}
