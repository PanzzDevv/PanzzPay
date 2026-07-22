package com.panzzpay.forwarder

import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.os.Bundle
import android.provider.Settings
import android.widget.Button
import android.widget.EditText
import android.widget.Switch
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import org.json.JSONObject
import java.io.OutputStreamWriter
import java.net.HttpURLConnection
import java.net.URL
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlin.concurrent.thread

class MainActivity : AppCompatActivity() {

    private lateinit var switchService: Switch
    private lateinit var switchVoice: Switch
    private lateinit var etWebhookUrl: EditText
    private lateinit var btnPasteUrl: Button
    private lateinit var btnSave: Button
    private lateinit var btnGrantPermission: Button
    private lateinit var btnTestWebhook: Button
    private lateinit var tvPermissionStatus: TextView
    private lateinit var tvLogConsole: TextView

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

        val prefs = getSharedPreferences("PanzzPayPrefs", Context.MODE_PRIVATE)
        val savedUrl = prefs.getString("webhook_url", "https://panzzpay.vercel.app/api/webhook/callback")
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
                if (pastedText.startsWith("http://") || pastedText.startsWith("https://")) {
                    etWebhookUrl.setText(pastedText)
                    appendLog("URL berhasil ditempel dari Clipboard")
                    Toast.makeText(this, "URL Webhook Berhasil Ditempel!", Toast.LENGTH_SHORT).show()
                } else {
                    Toast.makeText(this, "Teks di clipboard bukan URL Webhook yang valid", Toast.LENGTH_SHORT).show()
                }
            } else {
                Toast.makeText(this, "Clipboard Anda kosong", Toast.LENGTH_SHORT).show()
            }
        }

        btnSave.setOnClickListener {
            val newUrl = etWebhookUrl.text.toString().trim()
            if (newUrl.isNotEmpty()) {
                prefs.edit().putString("webhook_url", newUrl).apply()
                appendLog("Target Webhook URL disimpan: $newUrl")
                Toast.makeText(this, "Target Webhook URL Disimpan!", Toast.LENGTH_SHORT).show()
            } else {
                Toast.makeText(this, "URL tidak boleh kosong", Toast.LENGTH_SHORT).show()
            }
        }

        btnGrantPermission.setOnClickListener {
            appendLog("Membuka pengaturan Izin Akses Notifikasi Android...")
            startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS))
        }

        btnTestWebhook.setOnClickListener {
            val urlStr = etWebhookUrl.text.toString().trim()
            if (urlStr.isNotEmpty()) {
                sendTestPayload(urlStr)
            } else {
                Toast.makeText(this, "URL Webhook belum diisi", Toast.LENGTH_SHORT).show()
            }
        }

        appendLog("PanzzPay Listener Siap & Running")

        // Cek pembaruan aplikasi otomatis dari server PanzzPay
        val targetUrl = savedUrl ?: "https://panzzpay.vercel.app/api/webhook/callback"
        UpdateManager.checkForUpdate(this, targetUrl)
    }

    override fun onResume() {
        super.onResume()
        updatePermissionStatus()
    }

    private fun updatePermissionStatus() {
        val flat = Settings.Secure.getString(contentResolver, "enabled_notification_listeners")
        val isGranted = flat != null && flat.contains(packageName)

        if (isGranted) {
            tvPermissionStatus.text = "Izin Notifikasi: DIBERIKAN ✅"
            tvPermissionStatus.setTextColor(Color.parseColor("#10B981"))
        } else {
            tvPermissionStatus.text = "Izin Notifikasi: BELUM DIBERIKAN ⚠️"
            tvPermissionStatus.setTextColor(Color.parseColor("#EF4444"))
        }
    }

    private fun appendLog(msg: String) {
        val timeStr = SimpleDateFormat("HH:mm:ss", Locale.getDefault()).format(Date())
        val logLine = "[$timeStr] $msg"
        runOnUiThread {
            val currentText = tvLogConsole.text.toString()
            tvLogConsole.text = "$logLine\n$currentText".take(1000)
        }
    }

    private fun sendTestPayload(webhookUrl: String) {
        appendLog("Mengirim test webhook payload ke $webhookUrl...")
        thread {
            try {
                val url = URL(webhookUrl)
                val conn = url.openConnection() as HttpURLConnection
                conn.requestMethod = "POST"
                conn.setRequestProperty("Content-Type", "application/json")
                conn.doOutput = true
                conn.connectTimeout = 8000
                conn.readTimeout = 8000

                val payload = JSONObject().apply {
                    put("title", "Transfer Masuk Rp 50.000")
                    put("message", "Pembayaran QRIS Rp 50.000 dari ShopeePay diterima (Test PanzzPay App)")
                    put("package_name", "com.shopeepay.id")
                    put("source", "PanzzPay Android App Forwarder v2.0")
                    put("timestamp", System.currentTimeMillis())
                }

                val writer = OutputStreamWriter(conn.outputStream)
                writer.write(payload.toString())
                writer.flush()
                writer.close()

                val code = conn.responseCode
                appendLog("⚡ Test Webhook Berhasil! HTTP Status $code")
                runOnUiThread {
                    Toast.makeText(this, "⚡ Test Webhook Berhasil (HTTP $code)", Toast.LENGTH_LONG).show()
                }
                conn.disconnect()
            } catch (e: Exception) {
                appendLog("❌ Gagal Tes Webhook: ${e.message}")
                runOnUiThread {
                    Toast.makeText(this, "❌ Gagal Tes Webhook: ${e.message}", Toast.LENGTH_LONG).show()
                }
            }
        }
    }
}
