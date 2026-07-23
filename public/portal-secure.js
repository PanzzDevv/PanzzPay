(() => {
  'use strict';

  let merchant = null;
  let oneTimeCredentials = null;
  let pendingEmail = '';
  let pendingPassword = '';
  let dashboardTimer = null;

  const byId = id => document.getElementById(id);
  const formatRupiah = value => `Rp ${Number(value || 0).toLocaleString('id-ID')}`;

  function notify(message, title = 'PanzzPay Gateway') {
    const overlay = byId('panzzpayModalOverlay');
    if (!overlay) return window.alert(message);
    byId('panzzpayModalTitle').textContent = title;
    byId('panzzpayModalMessage').textContent = message;
    overlay.style.display = 'flex';
  }

  window.showPanzzPayModal = notify;

  function closeModal() {
    const overlay = byId('panzzpayModalOverlay');
    if (overlay) overlay.style.display = 'none';
    const message = byId('panzzpayModalMessage');
    if (message) message.textContent = '';
  }

  async function request(url, options = {}) {
    const response = await fetch(url, {
      credentials: 'same-origin',
      ...options,
      headers: {
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(options.headers || {})
      }
    });
    const data = await response.json().catch(() => ({ ok: false, message: 'Respons server tidak valid.' }));
    if (!response.ok) throw Object.assign(new Error(data.message || 'Request gagal.'), { status: response.status, data });
    return data;
  }

  async function initializeFirebase() {
    if (!window.firebase) return false;
    const config = await request('/api/auth/config');
    if (!config.enabled) return false;
    if (!firebase.apps.length) firebase.initializeApp(config);
    return true;
  }

  function showAuth() {
    merchant = null;
    if (dashboardTimer) clearInterval(dashboardTimer);
    byId('authSection').style.display = 'block';
    byId('merchantDashboard').style.display = 'none';
  }

  function applyCredentials(credentials) {
    oneTimeCredentials = credentials || null;
    const apiInput = byId('displayApiKey');
    const webhookInput = byId('displayWebhookUrl');
    if (!apiInput || !webhookInput) return;
    const hostUrl = `${window.location.protocol}//${window.location.host}`;

    if (credentials?.api_key) {
      apiInput.value = credentials.api_key;
    } else if (merchant?.api_key_hint) {
      apiInput.value = merchant.api_key_hint;
    } else {
      apiInput.value = 'Klik "Revoke / Reset" untuk membuat kredensial baru';
    }

    if (credentials?.webhook_url) {
      webhookInput.value = credentials.webhook_url;
    } else if (merchant?.webhook_token_hint) {
      webhookInput.value = `${hostUrl}/api/webhook/callback#token=${merchant.webhook_token_hint}`;
    } else {
      webhookInput.value = 'Klik "Revoke / Reset" untuk membuat kredensial baru';
    }
  }

  async function rotateCredentials() {
    if (!window.confirm('Kredensial lama akan langsung tidak berlaku. Lanjutkan untuk membuat/merevoke kredensial baru?')) return;
    try {
      const data = await request('/api/merchant/credentials/rotate', { method: 'POST', body: '{}' });
      applyCredentials(data.credentials);
      notify('Kredensial baru sudah dibuat dan hanya ditampilkan penuh pada sesi ini. Salin API key dan URL webhook Anda sekarang.', 'Kredensial Dirotasi');
    } catch (error) {
      notify(error.message, 'Revoke Gagal');
    }
  }

  async function copyToClipboard(kind) {
    const apiInput = byId('displayApiKey');
    const webhookInput = byId('displayWebhookUrl');
    let value = '';

    if (kind === 'api') {
      value = oneTimeCredentials?.api_key || apiInput?.value || '';
    } else {
      value = oneTimeCredentials?.webhook_url || webhookInput?.value || '';
    }

    if (!value || value.startsWith('Klik "Revoke')) {
      notify('Kredensial belum tersedia. Silakan klik tombol Revoke / Reset Kredensial.', 'Belum Ada Kredensial');
      return;
    }

    try {
      await navigator.clipboard.writeText(value);
      notify('Berhasil disalin ke clipboard.', 'Tersalin');
    } catch {
      const input = kind === 'api' ? apiInput : webhookInput;
      if (input) {
        input.select();
        document.execCommand('copy');
      }
      notify('Berhasil disalin ke clipboard.', 'Tersalin');
    }
  }

  function renderInvoices(invoices) {
    const body = byId('merchantTableBody');
    if (!body) return;
    body.replaceChildren();
    let paid = 0;
    let pending = 0;
    let revenue = 0;
    invoices.forEach(invoice => {
      if (invoice.status === 'PAID') {
        paid += 1;
        revenue += Number(invoice.total_amount || 0);
      }
      if (invoice.status === 'PENDING') pending += 1;
      const row = document.createElement('tr');
      const values = [
        invoice.id,
        new Date(invoice.created_at).toLocaleString('id-ID'),
        formatRupiah(invoice.total_amount),
        invoice.status,
        invoice.payment_source || '-'
      ];
      values.forEach(value => {
        const cell = document.createElement('td');
        cell.textContent = value;
        row.appendChild(cell);
      });
      const action = document.createElement('td');
      if (invoice.status === 'PENDING') {
        const button = document.createElement('button');
        button.className = 'btn btn-dark';
        button.textContent = 'Tandai Lunas';
        button.addEventListener('click', () => markPaid(invoice.id));
        action.appendChild(button);
      } else {
        action.textContent = '-';
      }
      row.appendChild(action);
      body.appendChild(row);
    });
    if (!invoices.length) {
      const row = document.createElement('tr');
      const cell = document.createElement('td');
      cell.colSpan = 6;
      cell.textContent = 'Belum ada transaksi.';
      row.appendChild(cell);
      body.appendChild(row);
    }
    byId('statOmset').textContent = formatRupiah(revenue);
    byId('statPaid').textContent = String(paid);
    byId('statPending').textContent = String(pending);
  }

  async function loadMerchantData() {
    try {
      const data = await request('/api/invoices?limit=50');
      renderInvoices(data.invoices || []);
    } catch (error) {
      if (error.status === 401) showAuth();
    }
  }

  async function markPaid(invoiceId) {
    if (!window.confirm(`Tandai ${invoiceId} sebagai PAID?`)) return;
    try {
      await request(`/api/merchant/invoices/${encodeURIComponent(invoiceId)}/mark-paid`, { method: 'POST', body: '{}' });
      await loadMerchantData();
    } catch (error) {
      notify(error.message, 'Gagal');
    }
  }

  function showDashboard(profile, credentials = null) {
    merchant = profile;
    pendingPassword = '';
    pendingEmail = '';
    byId('authSection').style.display = 'none';
    byId('merchantDashboard').style.display = 'block';
    byId('merchantNameTitle').textContent = `Halo, ${profile.name}`;
    byId('displayQrisPayload').value = profile.qris_payload || '';
    byId('badgeQrisStatus').textContent = profile.qris_configured ? 'QRIS Toko Aktif' : 'QRIS Belum Diatur';
    byId('badgeQrisStatus').className = `badge ${profile.qris_configured ? 'badge-paid' : 'badge-pending'}`;
    byId('superAdminShortcutCard').style.display = profile.role === 'superadmin' ? 'block' : 'none';
    applyCredentials(credentials);
    loadMerchantData();
    if (dashboardTimer) clearInterval(dashboardTimer);
    dashboardTimer = setInterval(loadMerchantData, 15_000);
  }

  async function restoreSession() {
    try {
      const data = await request('/api/auth/session');
      if (data.authenticated && data.merchant) showDashboard(data.merchant);
      else showAuth();
    } catch {
      showAuth();
    }
  }

  document.addEventListener('DOMContentLoaded', async () => {
    byId('panzzpayModalCloseBtn')?.addEventListener('click', closeModal);
    byId('tabRegisterBtn')?.addEventListener('click', () => {
      byId('registerForm').style.display = 'block';
      byId('loginForm').style.display = 'none';
      byId('otpSection').style.display = 'none';
    });
    byId('tabLoginBtn')?.addEventListener('click', () => {
      byId('registerForm').style.display = 'none';
      byId('loginForm').style.display = 'block';
      byId('otpSection').style.display = 'none';
    });

    byId('registerForm')?.addEventListener('submit', async event => {
      event.preventDefault();
      pendingEmail = byId('regEmail').value.trim();
      pendingPassword = byId('regPassword').value;
      try {
        const data = await request('/api/auth/register', {
          method: 'POST',
          body: JSON.stringify({ name: byId('regName').value.trim(), email: pendingEmail, password: pendingPassword })
        });
        byId('otpEmailTarget').textContent = pendingEmail;
        byId('otpSection').style.display = 'block';
        notify(`${data.message}\n\nAPI key dan URL webhook hanya ditampilkan sekali:\n${data.credentials.api_key}\n${data.credentials.webhook_url}`, 'Simpan Kredensial Anda');
      } catch (error) {
        notify(error.message, 'Pendaftaran Gagal');
      }
    });

    byId('loginForm')?.addEventListener('submit', async event => {
      event.preventDefault();
      pendingEmail = byId('loginEmail').value.trim();
      pendingPassword = byId('loginPassword').value;
      try {
        const data = await request('/api/auth/login', {
          method: 'POST',
          body: JSON.stringify({ email: pendingEmail, password: pendingPassword })
        });
        showDashboard(data.merchant);
      } catch (error) {
        if (error.data?.code === 'EMAIL_NOT_VERIFIED') {
          byId('otpEmailTarget').textContent = pendingEmail;
          byId('otpSection').style.display = 'block';
        }
        notify(error.message, error.data?.code === 'EMAIL_NOT_VERIFIED' ? 'Verifikasi Diperlukan' : 'Login Gagal');
      }
    });

    byId('btnResendOtp')?.addEventListener('click', async () => {
      if (!pendingEmail || !pendingPassword) return notify('Daftar ulang atau isi email dan password pada form login.', 'Data Tidak Lengkap');
      try {
        const data = await request('/api/auth/resend-verification', {
          method: 'POST', body: JSON.stringify({ email: pendingEmail, password: pendingPassword })
        });
        notify(data.message);
      } catch (error) {
        notify(error.message, 'Gagal');
      }
    });

    byId('btnGoogleAuth')?.addEventListener('click', async () => {
      try {
        await initializeFirebase();
        await firebase.auth().setPersistence(firebase.auth.Auth.Persistence.NONE);
        const result = await firebase.auth().signInWithPopup(new firebase.auth.GoogleAuthProvider());
        const idToken = await result.user.getIdToken(true);
        const data = await request('/api/auth/google', {
          method: 'POST', headers: { Authorization: `Bearer ${idToken}` }, body: '{}'
        });
        await firebase.auth().signOut();
        showDashboard(data.merchant, data.credentials);
      } catch (error) {
        notify(error.message, 'Google Login Gagal');
      }
    });

    byId('googleModalOverlay')?.remove();
    byId('btnLogout')?.addEventListener('click', async () => {
      await request('/api/auth/logout', { method: 'POST', body: '{}' }).catch(() => {});
      if (window.firebase?.apps?.length) await firebase.auth().signOut().catch(() => {});
      showAuth();
    });
    byId('btnCopyApiKey')?.addEventListener('click', () => copyToClipboard('api'));
    byId('btnCopyWebhookUrl')?.addEventListener('click', () => copyToClipboard('webhook'));
    byId('btnRevokeCredentials')?.addEventListener('click', rotateCredentials);

    byId('btnUploadQrisImage')?.addEventListener('click', () => byId('qrisFileInput').click());
    byId('qrisFileInput')?.addEventListener('change', event => {
      const file = event.target.files?.[0];
      if (!file || !file.type.startsWith('image/') || file.size > 3_000_000) return notify('Pilih gambar maksimal 3 MB.', 'File Tidak Valid');
      const reader = new FileReader();
      reader.onload = async loadEvent => {
        try {
          const data = await request('/api/qris/decode', {
            method: 'POST', body: JSON.stringify({ image_base64: loadEvent.target.result })
          });
          byId('displayQrisPayload').value = data.payload;
        } catch (error) {
          notify(error.message, 'QRIS Tidak Terbaca');
        }
      };
      reader.readAsDataURL(file);
    });
    byId('btnSaveQrisPayload')?.addEventListener('click', async () => {
      try {
        const data = await request('/api/merchant/qris-payload', {
          method: 'POST', body: JSON.stringify({ qris_payload: byId('displayQrisPayload').value.trim() })
        });
        merchant = data.merchant;
        showDashboard(merchant, oneTimeCredentials);
        notify('QRIS merchant berhasil disimpan.');
      } catch (error) {
        notify(error.message, 'Gagal Menyimpan QRIS');
      }
    });

    await restoreSession();
  });
})();
