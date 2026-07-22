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

---

## 📱 Fitur Utama Aplikasi PanzzPay Forwarder:

- [x] **Akses Notifikasi Otomatis (`NotificationListenerService`)**: Membaca push notification SMS / App dari Bank & e-Wallet (DANA, ShopeePay, GoPay, OVO, m-BCA, BRImo, Livin by Mandiri, GoBiz).
- [x] **Pengaturan Webhook URL**: Menyimpan URL target PanzzPay Anda (`http://domain-anda.com/api/webhook/callback`).
- [x] **Saklar On/Off Service State**: Layanan dapat diaktifkan atau dinonaktifkan sewaktu-waktu.
- [x] **Tombol Tes Webhook Direct**: Mengirim notifikasi tiruan 10.338 untuk menguji koneksi ke PanzzPay.
