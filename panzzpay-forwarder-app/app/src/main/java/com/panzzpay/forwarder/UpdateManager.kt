package com.panzzpay.forwarder

import android.app.ProgressDialog
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.FileProvider
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import kotlin.concurrent.thread

data class UpdateInfo(
    val versionCode: Int,
    val versionName: String,
    val downloadUrl: String,
    val releaseNotes: String,
    val forceUpdate: Boolean
)

object UpdateManager {

    fun checkForUpdate(activity: AppCompatActivity, webhookUrl: String) {
        val baseUrl = try {
            val url = URL(webhookUrl)
            "${url.protocol}://${url.host}${if (url.port != -1) ":${url.port}" else ""}"
        } catch (e: Exception) {
            "https://panzzpay.vercel.app"
        }

        val checkApiUrl = "$baseUrl/api/app/check-update"

        thread {
            try {
                val conn = URL(checkApiUrl).openConnection() as HttpURLConnection
                conn.requestMethod = "GET"
                conn.connectTimeout = 8000
                conn.readTimeout = 8000

                if (conn.responseCode == 200) {
                    val jsonStr = conn.inputStream.bufferedReader().use { it.readText() }
                    val json = JSONObject(jsonStr)

                    if (json.optBoolean("ok", false)) {
                        val serverVersionCode = json.optInt("versionCode", 1)
                        val versionName = json.optString("versionName", "2.1")
                        val downloadUrl = json.optString("downloadUrl", "")
                        val releaseNotes = json.optString("releaseNotes", "Versi baru tersedia.")
                        val forceUpdate = json.optBoolean("forceUpdate", false)

                        val currentVersionCode = getAppVersionCode(activity)

                        if (serverVersionCode > currentVersionCode) {
                            val updateInfo = UpdateInfo(
                                versionCode = serverVersionCode,
                                versionName = versionName,
                                downloadUrl = downloadUrl,
                                releaseNotes = releaseNotes,
                                forceUpdate = forceUpdate
                            )
                            activity.runOnUiThread {
                                showUpdateDialog(activity, updateInfo)
                            }
                        }
                    }
                }
                conn.disconnect()
            } catch (e: Exception) {
                // Silently ignore connection errors during background update check
            }
        }
    }

    private fun getAppVersionCode(context: Context): Int {
        return try {
            val pInfo = context.packageManager.getPackageInfo(context.packageName, 0)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                pInfo.longVersionCode.toInt()
            } else {
                @Suppress("DEPRECATION")
                pInfo.versionCode
            }
        } catch (e: Exception) {
            1
        }
    }

    private fun showUpdateDialog(activity: AppCompatActivity, updateInfo: UpdateInfo) {
        val builder = AlertDialog.Builder(activity)
            .setTitle("📢 Pembaruan Aplikasi Tersedia (v${updateInfo.versionName})")
            .setMessage(updateInfo.releaseNotes)
            .setCancelable(!updateInfo.forceUpdate)
            .setPositiveButton("Update Sekarang") { _, _ ->
                checkPermissionAndDownload(activity, updateInfo.downloadUrl)
            }

        if (!updateInfo.forceUpdate) {
            builder.setNegativeButton("Nanti") { dialog, _ ->
                dialog.dismiss()
            }
        }

        builder.show()
    }

    private fun checkPermissionAndDownload(activity: AppCompatActivity, downloadUrl: String) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            if (!activity.packageManager.canRequestPackageInstalls()) {
                Toast.makeText(
                    activity,
                    "Aktifkan izin instalasi dari sumber ini untuk melanjutkan pembaruan.",
                    Toast.LENGTH_LONG
                ).show()
                val intent = Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES).apply {
                    data = Uri.parse("package:${activity.packageName}")
                }
                activity.startActivity(intent)
                return
            }
        }
        downloadAndInstallApk(activity, downloadUrl)
    }

    private fun downloadAndInstallApk(activity: AppCompatActivity, downloadUrl: String) {
        @Suppress("DEPRECATION")
        val progressDialog = ProgressDialog(activity).apply {
            setTitle("Mengunduh Pembaruan")
            setMessage("Mohon tunggu sebentar...")
            setProgressStyle(ProgressDialog.STYLE_HORIZONTAL)
            isIndeterminate = false
            setCancelable(false)
            show()
        }

        thread {
            try {
                var currentUrl = downloadUrl
                var connection: HttpURLConnection
                var status: Int
                var redirectCount = 0

                do {
                    val url = URL(currentUrl)
                    connection = url.openConnection() as HttpURLConnection
                    connection.connectTimeout = 15000
                    connection.readTimeout = 45000
                    connection.instanceFollowRedirects = true
                    connection.setRequestProperty("User-Agent", "PanzzPay-Android-Updater")
                    connection.connect()

                    status = connection.responseCode
                    if (status == HttpURLConnection.HTTP_MOVED_TEMP || status == HttpURLConnection.HTTP_MOVED_PERM || status == HttpURLConnection.HTTP_SEE_OTHER || status == 307 || status == 308) {
                        val redirectedUrl = connection.getHeaderField("Location")
                        if (!redirectedUrl.isNullOrEmpty()) {
                            currentUrl = redirectedUrl
                            connection.disconnect()
                            redirectCount++
                        } else {
                            break
                        }
                    } else {
                        break
                    }
                } while (redirectCount < 5)

                val fileLength = connection.contentLength
                val apkFile = File(activity.getExternalFilesDir(null), "panzzpay-forwarder-update.apk")

                val input: InputStream = connection.inputStream
                val output = FileOutputStream(apkFile)

                val data = ByteArray(8192)
                var total: Long = 0
                var count: Int

                while (input.read(data).also { count = it } != -1) {
                    total += count.toLong()
                    if (fileLength > 0) {
                        val progress = (total * 100 / fileLength).toInt()
                        activity.runOnUiThread {
                            progressDialog.progress = progress
                        }
                    }
                    output.write(data, 0, count)
                }

                output.flush()
                output.close()
                input.close()
                connection.disconnect()

                activity.runOnUiThread {
                    progressDialog.dismiss()
                    promptInstallApk(activity, apkFile)
                }

            } catch (e: Exception) {
                activity.runOnUiThread {
                    progressDialog.dismiss()
                    Toast.makeText(activity, "❌ Gagal mengunduh update: ${e.message}", Toast.LENGTH_LONG).show()
                }
            }
        }
    }

    fun promptInstallApk(activity: AppCompatActivity, apkFile: File) {
        if (!apkFile.exists()) {
            Toast.makeText(activity, "File installer tidak ditemukan", Toast.LENGTH_SHORT).show()
            return
        }

        try {
            val apkUri: Uri = FileProvider.getUriForFile(
                activity,
                "${activity.packageName}.fileprovider",
                apkFile
            )

            val installIntent = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(apkUri, "application/vnd.android.package-archive")
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }

            activity.startActivity(installIntent)
        } catch (e: Exception) {
            Toast.makeText(activity, "❌ Gagal membuka installer: ${e.message}", Toast.LENGTH_LONG).show()
        }
    }
}
