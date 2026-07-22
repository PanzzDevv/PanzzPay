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
            "id.dana",                   // DANA
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

        val packageName = sbn.packageName
        val extras = sbn.notification.extras
        val title = extras.getString(Notification.EXTRA_TITLE) ?: ""
        val text = extras.getCharSequence(Notification.EXTRA_TEXT)?.toString() ?: ""

        val prefs = getSharedPreferences("PanzzPayPrefs", Context.MODE_PRIVATE)
        val isServiceEnabled = prefs.getBoolean("service_enabled", true)
        val webhookUrl = prefs.getString("webhook_url", "https://panzzpay.vercel.app/api/webhook/callback") ?: ""

        if (!isServiceEnabled || webhookUrl.isEmpty()) {
            Log.d(TAG, "PanzzPay Service is disabled or Webhook URL is empty")
            return
        }

        // Check if package is in target list or matches payment notification text
        val isTargetApp = TARGET_PACKAGES.contains(packageName) || 
                title.contains("pembayaran", ignoreCase = true) ||
                title.contains("transfer", ignoreCase = true) ||
                text.contains("rp", ignoreCase = true) ||
                text.contains("diterima", ignoreCase = true)

        if (isTargetApp && text.isNotEmpty()) {
            Log.i(TAG, "Captured Payment Notification from $packageName: $title - $text")
            speakNotification(text)
            sendNotificationToWebhook(webhookUrl, packageName, title, text)
        }
    }

    private fun speakNotification(messageText: String) {
        val prefs = getSharedPreferences("PanzzPayPrefs", Context.MODE_PRIVATE)
        val isVoiceEnabled = prefs.getBoolean("voice_enabled", true)

        if (!isVoiceEnabled || !isTtsInitialized) return

        try {
            val speechText = "Pembayaran PanzzPay masuk! $messageText"
            tts?.speak(speechText, TextToSpeech.QUEUE_FLUSH, null, "PanzzPayTTSId")
        } catch (e: Exception) {
            Log.e(TAG, "TTS speak error: ${e.message}")
        }
    }

    private fun sendNotificationToWebhook(webhookUrl: String, packageName: String, title: String, text: String) {
        thread {
            try {
                val url = URL(webhookUrl)
                val conn = url.openConnection() as HttpURLConnection
                conn.requestMethod = "POST"
                conn.setRequestProperty("Content-Type", "application/json; charset=UTF-8")
                conn.setRequestProperty("User-Agent", "PanzzPay-Android-Forwarder/2.0")
                conn.doOutput = true
                conn.connectTimeout = 10000
                conn.readTimeout = 10000

                val payload = JSONObject().apply {
                    put("title", title)
                    put("message", text)
                    put("package_name", packageName)
                    put("timestamp", System.currentTimeMillis())
                    put("source", "PanzzPay Android App")
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
