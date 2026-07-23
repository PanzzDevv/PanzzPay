# PanzzPay Forwarder - Android Native App Source Code

Proyek aplikasi Android Native (Kotlin) khusus untuk **PanzzPay Gateway**. Aplikasi ini bertugas membaca notifikasi dana masuk di Smartphone Android merchant dan meneruskannya ke server PanzzPay via Webhook secara otomatis & realtime.

---

## 📂 Struktur Proyek Android

```text
panzzpay-forwarder-app/
├── app/
│   └── src/
│       └── main/
│           ├── AndroidManifest.xml
│           ├── java/com/panzzpay/forwarder/
│           │   ├── MainActivity.kt               (Tampilan UI Setting App & Tes Webhook)
│           │   └── PanzzPayNotificationService.kt (Layanan Listener Notifikasi HP)
│           └── res/layout/
│               └── activity_main.xml            (Desain Layout UI PanzzPay)
└── README.md
```

---

## 🛠️ Cara Membuka & Build APK di Android Studio:

1. Buka aplikasi **Android Studio**.
2. Pilih **Open an Existing Project** dan arahkan ke folder:
   `c:\Users\panzz\Desktop\PanzzPay\panzzpay-forwarder-app`
3. Jalankan menu **Build > Build Bundle(s) / APK(s) > Build APK(s)**.
4. File `.apk` siap di-install di Smartphone Android Anda!

Build `debug` memakai debug key lokal Android. Untuk build `release`, signing key tidak boleh
disimpan di repository. Isi `ANDROID_KEYSTORE_PATH`, `ANDROID_KEYSTORE_PASSWORD`,
`ANDROID_KEY_ALIAS`, dan `ANDROID_KEY_PASSWORD` melalui environment variable. GitHub Actions
juga membutuhkan secret `ANDROID_KEYSTORE_BASE64` beserta tiga nilai signing lainnya.

## Versi dan pembaruan otomatis

Rilis APK wajib memakai tag semantik `vMAJOR.MINOR.PATCH`, contohnya `v2.2.0`. Gradle,
workflow GitHub Actions, dan API update memakai rumus version code yang sama:
`MAJOR * 1.000.000 + MINOR * 10.000 + PATCH`. Jangan mengubah `versionCode` secara manual
tanpa memperbarui skema ini karena dapat membuat notifikasi update muncul berulang.

---

## 📱 Fitur Utama Aplikasi PanzzPay Forwarder:

- [x] **Akses Notifikasi Otomatis (`NotificationListenerService`)**: Membaca push notification SMS / App dari Bank & e-Wallet (DANA, ShopeePay, GoPay, OVO, m-BCA, BRImo, Livin by Mandiri, GoBiz).
- [x] **Provisioning Webhook Aman**: Menyimpan URL provisioning dari dashboard dalam format `https://domain-anda.com/api/webhook/callback#token=...`. Fragment token tidak dikirim sebagai query URL; aplikasi memindahkannya ke header `Authorization: Bearer` saat request.
- [x] **Penyimpanan Token Terenkripsi**: Token webhook dienkripsi AES-GCM menggunakan key non-exportable dari Android Keystore dan backup aplikasi dinonaktifkan.
- [x] **Idempotency Event**: Setiap notifikasi mengirim `X-Webhook-Event-Id` agar retry tidak menggandakan pembayaran.
- [x] **Saklar On/Off Service State**: Layanan dapat diaktifkan atau dinonaktifkan sewaktu-waktu.
- [x] **Tombol Tes Webhook Direct**: Mengirim notifikasi tiruan 10.338 untuk menguji koneksi ke PanzzPay.
