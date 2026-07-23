# Firebase setup

Backend PanzzPay memakai Firebase Admin SDK untuk Firestore dan Firebase Auth. Jangan commit service-account key ke repository.

## 1. Buat key baru

Di Firebase Console buka **Project settings > Service accounts > Generate new private key**. Key lama yang pernah tersimpan di repository harus dianggap bocor dan dicabut.

## 2. Konfigurasi lokal (PowerShell)

Simpan JSON di luar repository, lalu jalankan:

```powershell
$env:GOOGLE_APPLICATION_CREDENTIALS='C:\secure\panzzpay-service-account.json'
$env:FIREBASE_PROJECT_ID='panzzpay'
$env:FIREBASE_API_KEY='firebase-web-api-key'
$env:FIREBASE_REQUIRED='true'
npm run check:firebase
npm start
```

Alternatif lokal: salin `firebase-config.example.json` menjadi `firebase-config.json`, lalu isi dengan key baru. File tersebut sudah diabaikan Git.

## 3. Konfigurasi Vercel

Tambahkan environment variables berikut untuk Production, Preview, dan Development:

- `FIREBASE_SERVICE_ACCOUNT_JSON`: seluruh isi JSON service account dalam satu baris.
- `FIREBASE_PROJECT_ID`
- `FIREBASE_API_KEY`
- `FIREBASE_AUTH_DOMAIN`
- `FIREBASE_STORAGE_BUCKET`
- `FIREBASE_MESSAGING_SENDER_ID`
- `FIREBASE_APP_ID`
- `FIREBASE_REQUIRED=true`
- `NODE_ENV=production`
- `ALLOWED_ORIGINS=https://domain-website-anda`
- `SUPER_ADMIN_UID`: UID akun admin yang sudah dibuat di Firebase Authentication.
- `SUPER_ADMIN_EMAIL`: email akun admin yang sama.

Isi konfigurasi Firebase Web App bisa juga disimpan sebagai JSON melalui `FIREBASE_WEB_CONFIG`.

## 4. Verifikasi

```powershell
npm test
npm run check:firebase
```

Setelah server hidup, endpoint berikut harus merespons HTTP 200 dengan `"status":"connected"`:

```text
GET /api/health/firebase
```

Pada production/Vercel, Firebase otomatis bersifat wajib dan aplikasi gagal tertutup jika kredensial atau koneksi cloud bermasalah. `FIREBASE_REQUIRED=true` tetap disarankan agar intent konfigurasi eksplisit.

## 5. Deploy Firestore security rules dan indexes

Firebase client tidak diberi akses langsung ke koleksi pembayaran. Semua operasi data melewati backend Admin SDK.

```powershell
firebase deploy --only firestore:rules,firestore:indexes
```

Aktifkan provider **Email/Password** dan **Google** pada Firebase Authentication. Tambahkan domain produksi ke **Authorized domains**. Setelah akun admin dibuat, salin UID-nya ke `SUPER_ADMIN_UID`; backend akan menetapkan role `superadmin` saat startup.

Kredensial API merchant disimpan sebagai hash. API key dan URL provisioning webhook hanya ditampilkan saat pendaftaran atau rotasi melalui dashboard—Firebase tidak dapat menampilkan ulang secret aslinya.
