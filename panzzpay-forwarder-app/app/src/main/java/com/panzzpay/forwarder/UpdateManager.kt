package com.panzzpay.forwarder

import android.app.ProgressDialog
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.provider.Settings
import android.util.Base64
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.FileProvider
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.Locale
import kotlin.concurrent.thread

data class UpdateInfo(
    val versionCode: Int,
    val versionName: String,
    val downloadUrl: String,
    val releaseNotes: String,
    val forceUpdate: Boolean
)

object UpdateManager {

    private const val OFFICIAL_UPDATE_BASE_URL = "https://panzzpay.vercel.app"
    private const val MAX_APK_BYTES = 100L * 1024L * 1024L

    fun checkForUpdate(activity: AppCompatActivity) {
        val checkApiUrl = "$OFFICIAL_UPDATE_BASE_URL/api/app/check-update"

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

                        if (serverVersionCode > currentVersionCode && isAllowedDownloadUrl(downloadUrl)) {
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
                if (!isAllowedDownloadUrl(downloadUrl)) throw SecurityException("Host update tidak diizinkan")
                var currentUrl = downloadUrl
                var connection: HttpURLConnection
                var status: Int
                var redirectCount = 0

                do {
                    val url = URL(currentUrl)
                    if (!isAllowedDownloadUrl(currentUrl)) throw SecurityException("Redirect update tidak diizinkan")
                    connection = url.openConnection() as HttpURLConnection
                    connection.connectTimeout = 15000
                    connection.readTimeout = 45000
                    connection.instanceFollowRedirects = false
                    connection.setRequestProperty("User-Agent", "PanzzPay-Android-Updater")
                    connection.connect()

                    status = connection.responseCode
                    if (status == HttpURLConnection.HTTP_MOVED_TEMP || status == HttpURLConnection.HTTP_MOVED_PERM || status == HttpURLConnection.HTTP_SEE_OTHER || status == 307 || status == 308) {
                        val redirectedUrl = connection.getHeaderField("Location")
                        if (!redirectedUrl.isNullOrEmpty()) {
                            currentUrl = URL(url, redirectedUrl).toString()
                            connection.disconnect()
                            redirectCount++
                        } else {
                            break
                        }
                    } else {
                        break
                    }
                } while (redirectCount < 5)

                if (status !in 200..299) throw IllegalStateException("Server update merespons HTTP $status")

                val fileLength = connection.contentLengthLong
                if (fileLength > MAX_APK_BYTES) throw SecurityException("Ukuran APK melebihi batas")
                val apkFile = File(activity.getExternalFilesDir(null), "panzzpay-forwarder-update.apk")

                connection.inputStream.use { input ->
                    FileOutputStream(apkFile).use { output ->
                        val data = ByteArray(8192)
                        var total = 0L
                        var count: Int

                        while (input.read(data).also { count = it } != -1) {
                            total += count.toLong()
                            if (total > MAX_APK_BYTES) throw SecurityException("Ukuran APK melebihi batas")
                            if (fileLength > 0) {
                                val progress = (total * 100 / fileLength).toInt()
                                activity.runOnUiThread { progressDialog.progress = progress }
                            }
                            output.write(data, 0, count)
                        }
                        output.flush()
                    }
                }
                connection.disconnect()

                if (!hasMatchingSignature(activity, apkFile)) {
                    apkFile.delete()
                    throw SecurityException("Sertifikat APK update tidak cocok dengan aplikasi terpasang")
                }

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

    private fun isAllowedDownloadUrl(value: String): Boolean = try {
        val url = URL(value)
        val host = url.host.lowercase(Locale.US)
        url.protocol.equals("https", ignoreCase = true) &&
                (host == "github.com" || host.endsWith(".githubusercontent.com"))
    } catch (e: Exception) {
        false
    }

    @Suppress("DEPRECATION")
    private fun hasMatchingSignature(context: Context, apkFile: File): Boolean {
        val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            PackageManager.GET_SIGNING_CERTIFICATES
        } else {
            PackageManager.GET_SIGNATURES
        }
        val candidate = context.packageManager.getPackageArchiveInfo(apkFile.absolutePath, flags) ?: return false
        if (candidate.packageName != context.packageName) return false
        val installed = context.packageManager.getPackageInfo(context.packageName, flags)
        return signerDigests(candidate).isNotEmpty() && signerDigests(candidate) == signerDigests(installed)
    }

    @Suppress("DEPRECATION")
    private fun signerDigests(info: PackageInfo): Set<String> {
        val signatures = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            info.signingInfo?.apkContentsSigners.orEmpty()
        } else {
            info.signatures.orEmpty()
        }
        return signatures.map { signature ->
            val digest = MessageDigest.getInstance("SHA-256").digest(signature.toByteArray())
            Base64.encodeToString(digest, Base64.NO_WRAP)
        }.toSet()
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
