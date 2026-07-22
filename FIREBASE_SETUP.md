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

Jika `FIREBASE_REQUIRED=true`, kegagalan read/write cloud akan diteruskan sebagai error agar aplikasi tidak diam-diam menganggap data lokal sudah tersimpan di Firebase.
