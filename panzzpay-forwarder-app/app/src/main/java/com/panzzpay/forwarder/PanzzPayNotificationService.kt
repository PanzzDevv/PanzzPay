package com.panzzpay.forwarder

import android.app.Notification
import android.content.Context
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import android.speech.tts.TextToSpeech
import android.util.Log
import org.json.JSONObject
import java.io.OutputStreamWriter
import java.net.HttpURLConnection
import java.net.URI
import java.net.URL
import java.util.Locale
import kotlin.concurrent.thread

class PanzzPayNotificationService : NotificationListenerService(), TextToSpeech.OnInitListener {

    private var tts: TextToSpeech? = null
    private var isTtsInitialized = false

    companion object {
        private const val TAG = "PanzzPayService"
        
        // Target Banking & E-Wallet Package Names
        val TARGET_PACKAGES = setOf(
            "id.dana",                   // DANA / DANA Bisnis
            "com.shopeepay.id",          // ShopeePay
            "com.shopee.id",             // Shopee App
            "com.gojek.app",             // GoPay / Gojek
            "com.bca",                   // m-BCA
            "id.co.bri.brimo",           // BRImo
            "id.bmri.livin",             // Livin by Mandiri
            "com.ovo",                   // OVO
            "id.gobiz.app",              // GoBiz Merchant
            "id.co.bankbsi.user",        // BSI Mobile
            "com.seabank.id"             // SeaBank
        )
    }

    override fun onCreate() {
        super.onCreate()
        try {
            tts = TextToSpeech(applicationContext, this)
        } catch (e: Exception) {
            Log.e(TAG, "Error initializing TextToSpeech: ${e.message}")
        }
    }

    override fun onInit(status: Int) {
        if (status == TextToSpeech.SUCCESS) {
            val result = tts?.setLanguage(Locale("id", "ID"))
            isTtsInitialized = (result != TextToSpeech.LANG_MISSING_DATA && result != TextToSpeech.LANG_NOT_SUPPORTED)
            Log.d(TAG, "TTS initialized. Supported ID locale: $isTtsInitialized")
        }
    }

    override fun onNotificationPosted(sbn: StatusBarNotification?) {
        super.onNotificationPosted(sbn)
        
        if (sbn == null) return

        val packageName = sbn.packageName.orEmpty()
        val extras = sbn.notification?.extras ?: return

        val title = (extras.getCharSequence(Notification.EXTRA_TITLE_BIG)?.toString()
            ?: extras.getCharSequence(Notification.EXTRA_TITLE)?.toString()
            ?: "").trim()

        val textCandidates = listOfNotNull(
            extras.getCharSequence(Notification.EXTRA_BIG_TEXT)?.toString(),
            extras.getCharSequence(Notification.EXTRA_TEXT)?.toString(),
            extras.getCharSequence(Notification.EXTRA_SUB_TEXT)?.toString(),
            extras.getCharSequenceArray(Notification.EXTRA_TEXT_LINES)?.joinToString(" "),
            sbn.notification?.tickerText?.toString()
        ).map { it.trim() }.filter { it.isNotEmpty() }

        val text = textCandidates.distinct().joinToString(" ")

        val webhookUrl = SecurePreferences.getWebhookUrl(this)

        if (webhookUrl.isEmpty()) {
            Log.d(TAG, "PanzzPay Webhook URL is empty")
            return
        }

        // Check if package is in target list
        val isTargetApp = TARGET_PACKAGES.any { target ->
            packageName.equals(target, ignoreCase = true) || packageName.contains(target, ignoreCase = true)
        }

        // Check text for payment-related keywords
        val combined = "$title $text".lowercase()
        val paymentKeywords = listOf(
            "rp", "idr", "pembayaran", "transfer", "transaksi",
            "diterima", "berhasil", "masuk", "sukses", "saldo",
            "topup", "top up", "top-up", "dana", "gopay", "ovo",
            "shopeepay", "bca", "bri", "mandiri", "bsi", "seabank",
            "qris", "merchant"
        )
        val hasPaymentKeyword = paymentKeywords.any { combined.contains(it) }

        val shouldProcess = isTargetApp || hasPaymentKeyword

        val messageToSend = if (text.isNotEmpty()) text else title
        if (shouldProcess && messageToSend.isNotEmpty()) {
            Log.i(TAG, "Payment notification captured from $packageName | Title: $title | Msg: $messageToSend")
            speakNotification(messageToSend)
            sendNotificationToWebhook(webhookUrl, packageName, title, messageToSend, "${sbn.key}:${sbn.postTime}")
        }
    }

    private fun speakNotification(messageText: String) {
        val prefs = getSharedPreferences("PanzzPayPrefs", Context.MODE_PRIVATE)
        val isVoiceEnabled = prefs.getBoolean("voice_enabled", false)

        if (!isVoiceEnabled || !isTtsInitialized) return

        try {
            val speechText = "Pembayaran PanzzPay masuk! $messageText"
            tts?.speak(speechText, TextToSpeech.QUEUE_FLUSH, null, "PanzzPayTTSId")
        } catch (e: Exception) {
            Log.e(TAG, "TTS speak error: ${e.message}")
        }
    }

    private fun sendNotificationToWebhook(webhookUrl: String, packageName: String, title: String, text: String, eventId: String) {
        thread {
            try {
                val provisioningUri = URI(webhookUrl)
                val token = provisioningUri.fragment.orEmpty().split('&')
                    .firstOrNull { it.startsWith("token=") }
                    ?.substringAfter("token=")
                    .orEmpty()
                if (token.isBlank()) throw IllegalArgumentException("Webhook token tidak ditemukan pada URL provisioning")
                val cleanUri = URI(provisioningUri.scheme, provisioningUri.authority, provisioningUri.path, null, null)
                val url = cleanUri.toURL()
                val conn = url.openConnection() as HttpURLConnection
                conn.requestMethod = "POST"
                conn.setRequestProperty("Content-Type", "application/json; charset=UTF-8")
                conn.setRequestProperty("User-Agent", "PanzzPay-Android-Forwarder/3.0")
                conn.setRequestProperty("Authorization", "Bearer $token")
                conn.setRequestProperty("X-Webhook-Event-Id", eventId)
                conn.doOutput = true
                conn.connectTimeout = 10000
                conn.readTimeout = 10000

                val payload = JSONObject().apply {
                    put("title", title)
                    put("message", text)
                    put("package_name", packageName)
                    put("timestamp", System.currentTimeMillis())
                    put("source", "PanzzPay Android App")
                    put("event_id", eventId)
                }

                val writer = OutputStreamWriter(conn.outputStream)
                writer.write(payload.toString())
                writer.flush()
                writer.close()

                val responseCode = conn.responseCode
                Log.d(TAG, "Webhook sent successfully! HTTP Status: $responseCode")
                conn.disconnect()
            } catch (e: Exception) {
                Log.e(TAG, "Error forwarding notification to PanzzPay Webhook: ${e.message}", e)
            }
        }
    }

    override fun onDestroy() {
        tts?.stop()
        tts?.shutdown()
        super.onDestroy()
    }
}
