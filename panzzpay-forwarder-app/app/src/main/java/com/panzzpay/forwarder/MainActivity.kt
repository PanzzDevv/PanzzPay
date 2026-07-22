package com.panzzpay.forwarder

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
import kotlin.concurrent.thread

class MainActivity : AppCompatActivity() {

    private lateinit var switchService: Switch
    private lateinit var etWebhookUrl: EditText
    private lateinit var btnSave: Button
    private lateinit var btnGrantPermission: Button
    private lateinit var btnTestWebhook: Button
    private lateinit var tvPermissionStatus: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        switchService = findViewById(R.id.switchService)
        etWebhookUrl = findViewById(R.id.etWebhookUrl)
        btnSave = findViewById(R.id.btnSave)
        btnGrantPermission = findViewById(R.id.btnGrantPermission)
        btnTestWebhook = findViewById(R.id.btnTestWebhook)
        tvPermissionStatus = findViewById(R.id.tvPermissionStatus)

        val prefs = getSharedPreferences("PanzzPayPrefs", Context.MODE_PRIVATE)
        val savedUrl = prefs.getString("webhook_url", "https://panzzpay.vercel.app/api/webhook/callback")
        val isEnabled = prefs.getBoolean("service_enabled", true)

        etWebhookUrl.setText(savedUrl)
        switchService.isChecked = isEnabled

        switchService.setOnCheckedChangeListener { _, isChecked ->
            prefs.edit().putBoolean("service_enabled", isChecked).apply()
            Toast.makeText(this, if (isChecked) "Layanan Forwarder Aktif" else "Layanan Nonaktif", Toast.LENGTH_SHORT).show()
        }

        btnSave.setOnClickListener {
            val newUrl = etWebhookUrl.text.toString().trim()
            if (newUrl.isNotEmpty()) {
                prefs.edit().putString("webhook_url", newUrl).apply()
                Toast.makeText(this, "Target Webhook URL Disimpan!", Toast.LENGTH_SHORT).show()
            } else {
                Toast.makeText(this, "URL tidak boleh kosong", Toast.LENGTH_SHORT).show()
            }
        }

        btnGrantPermission.setOnClickListener {
            startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS))
        }

        btnTestWebhook.setOnClickListener {
            val urlStr = etWebhookUrl.text.toString().trim()
            if (urlStr.isNotEmpty()) {
                sendTestPayload(urlStr)
            }
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
            tvPermissionStatus.text = "Izin Notifikasi: DIBERIKAN ✅"
            tvPermissionStatus.setTextColor(Color.parseColor("#10B981"))
        } else {
            tvPermissionStatus.text = "Izin Notifikasi: BELUM DIBERIKAN ⚠️"
            tvPermissionStatus.setTextColor(Color.parseColor("#EF4444"))
        }
    }

    private fun sendTestPayload(webhookUrl: String) {
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
                runOnUiThread {
                    Toast.makeText(this, "⚡ Test Webhook Berhasil (HTTP $code)", Toast.LENGTH_LONG).show()
                }
                conn.disconnect()
            } catch (e: Exception) {
                runOnUiThread {
                    Toast.makeText(this, "❌ Gagal Tes Webhook: ${e.message}", Toast.LENGTH_LONG).show()
                }
            }
        }
    }
}
