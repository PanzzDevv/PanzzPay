package com.panzzpay.forwarder

import android.annotation.SuppressLint
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.speech.tts.TextToSpeech
import android.widget.ArrayAdapter
import android.widget.Button
import android.widget.EditText
import android.widget.Spinner
import android.widget.TextView
import android.widget.Toast
import android.view.WindowManager
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import com.google.android.material.materialswitch.MaterialSwitch
import org.json.JSONObject
import java.io.OutputStreamWriter
import java.net.HttpURLConnection
import java.net.URI
import java.net.URL
import java.util.UUID
import java.text.NumberFormat
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlin.concurrent.thread

class MainActivity : AppCompatActivity(), TextToSpeech.OnInitListener {

    private lateinit var switchService: MaterialSwitch
    private lateinit var switchVoice: MaterialSwitch
    private lateinit var etWebhookUrl: EditText
    private lateinit var btnPasteUrl: Button
    private lateinit var btnSave: Button
    private lateinit var btnGrantPermission: Button
    private lateinit var btnTestWebhook: Button
    private lateinit var tvPermissionStatus: TextView
    private lateinit var tvLogConsole: TextView
    private lateinit var tvAppVersion: TextView

    private var tts: TextToSpeech? = null
    private var isTtsReady = false

    data class PaymentProviderOption(
        val name: String,
        val packageName: String,
        val titlePattern: String,
        val messagePattern: String
    )

    private val providerOptions = listOf(
        PaymentProviderOption("ShopeePay", "com.shopeepay.id", "ShopeePay: Transfer Masuk", "Pembayaran QRIS Rp %s dari ShopeePay diterima"),
        PaymentProviderOption("DANA", "id.dana", "DANA: Isi Saldo Berhasil", "Kamu dapat saldo Rp %s dari DANA QRIS Merchant"),
        PaymentProviderOption("GoPay / Gojek", "com.gojek.app", "GoPay Payment Received", "Transfer masuk Rp %s dari GoPay berhasil diterima"),
        PaymentProviderOption("OVO", "com.ovo", "OVO Cash Masuk", "Topup OVO Cash Rp %s berhasil dilakukan"),
        PaymentProviderOption("m-BCA", "com.bca", "m-BCA: Transfer Masuk", "m-Transfer Rp %s dari QRIS Merchant telah masuk"),
        PaymentProviderOption("BRImo", "id.co.bri.brimo", "BRImo Notification", "Transaksi masuk Rp %s via QRIS BRImo berhasil"),
        PaymentProviderOption("Livin' Mandiri", "id.bmri.livin", "Livin' Mandiri: Kredit", "Dana masuk Rp %s dari Transfer QRIS Mandiri")
    )

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        switchService = findViewById(R.id.switchService)
        switchVoice = findViewById(R.id.switchVoice)
        etWebhookUrl = findViewById(R.id.etWebhookUrl)
        btnPasteUrl = findViewById(R.id.btnPasteUrl)
        btnSave = findViewById(R.id.btnSave)
        btnGrantPermission = findViewById(R.id.btnGrantPermission)
        btnTestWebhook = findViewById(R.id.btnTestWebhook)
        tvPermissionStatus = findViewById(R.id.tvPermissionStatus)
        tvLogConsole = findViewById(R.id.tvLogConsole)
        tvAppVersion = findViewById(R.id.tvAppVersion)
        tvAppVersion.text = getString(R.string.app_version_format, getAppVersionName())

        try {
            tts = TextToSpeech(this, this)
        } catch (e: Exception) {
            appendLog("TTS tidak tersedia: ${e.message}")
        }

        val prefs = getSharedPreferences("PanzzPayPrefs", Context.MODE_PRIVATE)
        val savedUrl = SecurePreferences.getWebhookUrl(this)
        val isEnabled = prefs.getBoolean("service_enabled", true)
        val isVoiceEnabled = prefs.getBoolean("voice_enabled", true)

        etWebhookUrl.setText(savedUrl)
        switchService.isChecked = isEnabled
        switchVoice.isChecked = isVoiceEnabled

        switchService.setOnCheckedChangeListener { _, isChecked ->
            prefs.edit().putBoolean("service_enabled", isChecked).apply()
            appendLog(if (isChecked) "Layanan Forwarder diaktifkan" else "Layanan Forwarder dinonaktifkan")
            Toast.makeText(this, if (isChecked) "Layanan Forwarder Aktif" else "Layanan Nonaktif", Toast.LENGTH_SHORT).show()
        }

        switchVoice.setOnCheckedChangeListener { _, isChecked ->
            prefs.edit().putBoolean("voice_enabled", isChecked).apply()
            appendLog(if (isChecked) "Suara notifikasi (TTS) diaktifkan" else "Suara notifikasi (TTS) dinonaktifkan")
            Toast.makeText(this, if (isChecked) "Suara Uang Masuk Aktif" else "Suara Nonaktif", Toast.LENGTH_SHORT).show()
        }

        btnPasteUrl.setOnClickListener {
            val clipboard = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            val clipData = clipboard.primaryClip
            if (clipData != null && clipData.itemCount > 0) {
                val pastedText = clipData.getItemAt(0).text.toString().trim()
                if (isValidProvisioningUrl(pastedText)) {
                    etWebhookUrl.setText(pastedText)
                    etWebhookUrl.error = null
                    clipboard.setPrimaryClip(ClipData.newPlainText("", ""))
                    appendLog("URL berhasil ditempel dari Clipboard")
                    Toast.makeText(this, "URL Webhook Berhasil Ditempel!", Toast.LENGTH_SHORT).show()
                } else {
                    etWebhookUrl.error = getString(R.string.invalid_webhook_url)
                    Toast.makeText(this, "Teks di clipboard bukan URL Webhook yang valid", Toast.LENGTH_SHORT).show()
                }
            } else {
                Toast.makeText(this, "Clipboard Anda kosong", Toast.LENGTH_SHORT).show()
            }
        }

        btnSave.setOnClickListener {
            val newUrl = etWebhookUrl.text.toString().trim()
            if (isValidProvisioningUrl(newUrl) && SecurePreferences.putWebhookUrl(this, newUrl)) {
                etWebhookUrl.error = null
                appendLog("Target Webhook URL disimpan secara terenkripsi")
                Toast.makeText(this, "Target Webhook URL Disimpan!", Toast.LENGTH_SHORT).show()
            } else {
                etWebhookUrl.error = getString(R.string.invalid_webhook_url)
                etWebhookUrl.requestFocus()
            }
        }

        btnGrantPermission.setOnClickListener {
            appendLog("Membuka pengaturan Izin Akses Notifikasi Android...")
            startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS))
        }

        btnTestWebhook.setOnClickListener {
            val urlStr = etWebhookUrl.text.toString().trim()
            if (isValidProvisioningUrl(urlStr)) {
                etWebhookUrl.error = null
                showTestWebhookDialog(urlStr)
            } else {
                etWebhookUrl.error = if (urlStr.isEmpty()) {
                    getString(R.string.webhook_required)
                } else {
                    getString(R.string.invalid_webhook_url)
                }
                etWebhookUrl.requestFocus()
            }
        }

        appendLog("PanzzPay Listener Siap & Running")

        // Cek pembaruan aplikasi otomatis dari server PanzzPay
        UpdateManager.checkForUpdate(this)
    }

    private fun isValidProvisioningUrl(value: String): Boolean = runCatching {
        val uri = URI(value)
        val token = uri.fragment.orEmpty().split('&')
            .firstOrNull { it.startsWith("token=") }
            ?.substringAfter("token=")
            .orEmpty()
        uri.scheme.equals("https", ignoreCase = true) && !uri.host.isNullOrBlank() && token.length >= 32
    }.getOrDefault(false)

    private fun getAppVersionName(): String = try {
        packageManager.getPackageInfo(packageName, 0).versionName ?: "-"
    } catch (e: Exception) {
        "-"
    }

    override fun onInit(status: Int) {
        if (status == TextToSpeech.SUCCESS) {
            val result = tts?.setLanguage(Locale("id", "ID"))
            isTtsReady = (result != TextToSpeech.LANG_MISSING_DATA && result != TextToSpeech.LANG_NOT_SUPPORTED)
        }
    }

    override fun onResume() {
        super.onResume()
        updatePermissionStatus()
    }

    private fun updatePermissionStatus() {
        val flat = Settings.Secure.getString(contentResolver, "enabled_notification_listeners")
        val isGranted = flat != null && flat.contains(packageName)

        if (isGranted) {
            tvPermissionStatus.setText(R.string.permission_granted)
            tvPermissionStatus.setTextColor(ContextCompat.getColor(this, R.color.accent_emerald))
        } else {
            tvPermissionStatus.setText(R.string.permission_not_granted)
            tvPermissionStatus.setTextColor(ContextCompat.getColor(this, R.color.accent_rose))
        }
    }

    @SuppressLint("SetTextI18n")
    private fun appendLog(msg: String) {
        val timeStr = SimpleDateFormat("HH:mm:ss", Locale.getDefault()).format(Date())
        val logLine = "[$timeStr] $msg"
        runOnUiThread {
            val currentText = tvLogConsole.text.toString()
            tvLogConsole.text = "$logLine\n$currentText".take(1000)
        }
    }

    private fun showTestWebhookDialog(webhookUrl: String) {
        val dialogView = layoutInflater.inflate(R.layout.dialog_test_webhook, null)
        val spinnerProvider = dialogView.findViewById<Spinner>(R.id.spinnerProvider)
        val etTestAmount = dialogView.findViewById<EditText>(R.id.etTestAmount)

        val adapter = ArrayAdapter(this, R.layout.item_spinner_provider, providerOptions.map { it.name })
        adapter.setDropDownViewResource(R.layout.item_spinner_provider_dropdown)
        spinnerProvider.adapter = adapter

        AlertDialog.Builder(this)
            .setView(dialogView)
            .setPositiveButton(R.string.send_test) { _, _ ->
                val selectedIndex = spinnerProvider.selectedItemPosition
                val provider = providerOptions.getOrElse(selectedIndex) { providerOptions[0] }
                val amountStr = etTestAmount.text.toString().trim()
                val rawAmount = amountStr.toLongOrNull() ?: 50000L
                val formattedAmount = NumberFormat.getNumberInstance(Locale("id", "ID")).format(rawAmount)

                val title = provider.titlePattern
                val message = String.format(provider.messagePattern, formattedAmount)

                // 1. Munculkan notifikasi sistem di HP Android
                postSystemNotification(title, message)

                // 2. Kirim payload JSON ke Webhook server PanzzPay
                sendTestPayload(webhookUrl, provider.packageName, title, message)

                // 3. Ucapkan suara uang masuk jika fitur voice aktif
                if (switchVoice.isChecked && isTtsReady) {
                    try {
                        tts?.speak("Pembayaran PanzzPay masuk! $message", TextToSpeech.QUEUE_FLUSH, null, "TestTTSId")
                    } catch (e: Exception) {
                        // ignore TTS errors during test
                    }
                }
            }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    private fun postSystemNotification(title: String, message: String) {
        try {
            val notificationManager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            val channelId = "panzzpay_test_channel"
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                val channel = NotificationChannel(channelId, "PanzzPay Test Channel", NotificationManager.IMPORTANCE_HIGH).apply {
                    description = "Saluran pengujian notifikasi pembayaran PanzzPay"
                }
                notificationManager.createNotificationChannel(channel)
            }

            val builder = NotificationCompat.Builder(this, channelId)
                .setSmallIcon(R.drawable.ic_logo)
                .setContentTitle(title)
                .setContentText(message)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setAutoCancel(true)

            notificationManager.notify((System.currentTimeMillis() % 10000).toInt(), builder.build())
            appendLog("Notifikasi tes ditampilkan di status bar.")
        } catch (e: Exception) {
            appendLog("Gagal membuat notifikasi sistem: ${e.message}")
        }
    }

    private fun sendTestPayload(webhookUrl: String, packageName: String, title: String, message: String) {
        appendLog("Mengirim tes notifikasi payment [$packageName] ke Webhook...")
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
                val eventId = "test-${UUID.randomUUID()}"
                val conn = url.openConnection() as HttpURLConnection
                conn.requestMethod = "POST"
                conn.setRequestProperty("Content-Type", "application/json; charset=UTF-8")
                conn.setRequestProperty("User-Agent", "PanzzPay-Android-Forwarder/${getAppVersionName()}")
                conn.setRequestProperty("Authorization", "Bearer $token")
                conn.setRequestProperty("X-Webhook-Event-Id", eventId)
                conn.doOutput = true
                conn.connectTimeout = 8000
                conn.readTimeout = 8000

                val payload = JSONObject().apply {
                    put("title", title)
                    put("message", message)
                    put("package_name", packageName)
                    put("source", "PanzzPay App Test Simulation")
                    put("timestamp", System.currentTimeMillis())
                    put("event_id", eventId)
                }

                val writer = OutputStreamWriter(conn.outputStream)
                writer.write(payload.toString())
                writer.flush()
                writer.close()

                val code = conn.responseCode
                if (code !in 200..299) {
                    throw IllegalStateException("Server merespons HTTP $code")
                }
                appendLog("Tes webhook berhasil. Status HTTP $code\nPayload: $message")
                runOnUiThread {
                    Toast.makeText(this, "Tes webhook berhasil (HTTP $code)", Toast.LENGTH_LONG).show()
                }
                conn.disconnect()
            } catch (e: Exception) {
                appendLog("Tes webhook gagal: ${e.message}")
                runOnUiThread {
                    Toast.makeText(this, "Tes webhook gagal: ${e.message}", Toast.LENGTH_LONG).show()
                }
            }
        }
    }

    override fun onDestroy() {
        tts?.stop()
        tts?.shutdown()
        super.onDestroy()
    }
}
