document.addEventListener('DOMContentLoaded', () => {

  // --- STATE ---
  let activeInvoiceId = null;
  let pollInterval = null;
  let timerInterval = null;

  // --- HAMBURGER DRAWER MENU CONTROLS ---
  const btnHamburger = document.getElementById('btnHamburger');
  const btnCloseDrawer = document.getElementById('btnCloseDrawer');
  const navDrawer = document.getElementById('navDrawer');
  const navBackdrop = document.getElementById('navBackdrop');
  const drawerItems = document.querySelectorAll('.drawer-item');

  function openDrawer() {
    if (navDrawer) navDrawer.classList.add('open');
  }

  function closeDrawer() {
    if (navDrawer) navDrawer.classList.remove('open');
  }

  if (btnHamburger) btnHamburger.addEventListener('click', openDrawer);
  if (btnCloseDrawer) btnCloseDrawer.addEventListener('click', closeDrawer);
  if (navBackdrop) navBackdrop.addEventListener('click', closeDrawer);

  drawerItems.forEach(item => {
    item.addEventListener('click', () => {
      drawerItems.forEach(i => i.classList.remove('active'));
      item.classList.add('active');
      closeDrawer();
    });
  });

  // --- GLOBAL AUTH SESSION STATE FOR DRAWER ---
  function updateAuthUIState() {
    const container = document.getElementById('drawerAuthContainer');
    if (!container) return;

    const savedMerchantRaw = localStorage.getItem('panzzpay_merchant');
    if (savedMerchantRaw) {
      try {
        const merchant = JSON.parse(savedMerchantRaw);
        if (merchant && (merchant.api_key || merchant.email)) {
          container.innerHTML = `
            <div style="display: flex; flex-direction: column; gap: 0.6rem;">
              <a href="/portal.html" class="btn btn-primary" style="width: 100%; text-decoration: none; display: flex; align-items: center; justify-content: center; gap: 0.5rem;">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="3" y="3" width="7" height="7"></rect><rect x="14" y="3" width="7" height="7"></rect><rect x="14" y="14" width="7" height="7"></rect><rect x="3" y="14" width="7" height="7"></rect></svg>
                <span>📊 BUKA DASHBOARD SAYA</span>
              </a>
              <div style="display: flex; align-items: center; justify-content: space-between; padding: 0.5rem 0.8rem; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px; font-size: 0.8rem;">
                <span style="font-weight: 700; color: var(--text-primary); text-overflow: ellipsis; overflow: hidden; max-width: 170px; white-space: nowrap;">👤 ${merchant.name || merchant.email}</span>
                <button id="btnGlobalLogout" style="background: transparent; border: none; color: var(--accent-rose); font-weight: 800; cursor: pointer; font-size: 0.78rem;">Logout</button>
              </div>
              <div style="font-size: 0.75rem; color: var(--text-muted); text-align: center;">
                PanzzPay Gateway API v2.0
              </div>
            </div>
          `;

          const btnLogout = document.getElementById('btnGlobalLogout');
          if (btnLogout) {
            btnLogout.addEventListener('click', () => {
              localStorage.removeItem('panzzpay_merchant');
              localStorage.removeItem('panzzpay_sa_auth');
              updateAuthUIState();
              if (window.location.pathname.includes('portal.html')) {
                window.location.reload();
              }
            });
          }
          return;
        }
      } catch (e) {
        console.error('Error parsing merchant session:', e);
      }
    }

    // Default: Not Logged In State
    container.innerHTML = `
      <a href="/portal.html" class="btn btn-primary" style="width: 100%; text-decoration: none; display: flex; align-items: center; justify-content: center; gap: 0.5rem;">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"></path><polyline points="10 17 15 12 10 7"></polyline><line x1="15" y1="12" x2="3" y2="12"></line></svg>
        <span>🔑 DAFTAR / LOGIN</span>
      </a>
      <div style="font-size: 0.75rem; color: var(--text-muted); text-align: center; margin-top: 0.8rem;">
        PanzzPay Gateway API v2.0
      </div>
    `;
  }

  // Initialize Auth state
  updateAuthUIState();

  // --- DONATION PRESETS LOGIC ---
  const presetBtns = document.querySelectorAll('.preset-btn');
  const donationAmountInput = document.getElementById('donationAmount');
  const btnDonateSubmit = document.getElementById('btnDonateSubmit');

  presetBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      presetBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      if (donationAmountInput) {
        donationAmountInput.value = btn.getAttribute('data-amount');
      }
    });
  });

  if (btnDonateSubmit) {
    btnDonateSubmit.addEventListener('click', async () => {
      const amount = donationAmountInput ? donationAmountInput.value : 5000;
      const donorName = document.getElementById('donorName') ? document.getElementById('donorName').value : '';

      btnDonateSubmit.disabled = true;
      btnDonateSubmit.innerHTML = '<span>Membuat QRIS Donasi...</span>';

      try {
        const response = await fetch('/api/qris/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            base_amount: amount,
            auto_unique: true
          })
        });

        const data = await response.json();

        if (!data.ok) {
          alert('Gagal: ' + (data.message || 'Terjadi kesalahan'));
          return;
        }

        const inv = data.invoice;
        activeInvoiceId = inv.id;

        // Update UI Display
        document.getElementById('invoiceIdLabel').textContent = `DONASI - ${inv.id} (${donorName || 'Anonim'})`;
        document.getElementById('qrImage').src = inv.qr_png_data_url || 'https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=' + encodeURIComponent(inv.payload || 'DONATION');
        document.getElementById('totalAmountLabel').textContent = `Rp ${inv.total_amount.toLocaleString('id-ID')}`;
        document.getElementById('baseAmountLabel').textContent = `Rp ${inv.base_amount.toLocaleString('id-ID')}`;
        document.getElementById('uniqueCodeLabel').textContent = `${inv.unique_code}`;
        
        const badge = document.getElementById('invoiceBadge');
        badge.className = 'badge badge-pending';
        badge.textContent = 'DONASI PENDING';

        // Scroll to QR Result Card
        const qrResultCard = document.getElementById('qrResultCard');
        if (qrResultCard) {
          qrResultCard.scrollIntoView({ behavior: 'smooth' });
        }

        // Prefill Webhook Simulator amount
        document.getElementById('simAmount').value = inv.total_amount;
        document.getElementById('simPayload').value = JSON.stringify({ message: `Pembayaran masuk Rp ${inv.total_amount.toLocaleString('id-ID')} dari ShopeePay` }, null, 2);

        // Start Polling & Timer
        startStatusPolling(inv.id);
        startCountdownTimer(15 * 60);
        loadHistoryData();

        showToast(`QRIS Donasi Rp ${inv.total_amount.toLocaleString('id-ID')} Berhasil Dibuat!`);

      } catch (err) {
        console.error(err);
        alert('Gagal terhubung ke server');
      } finally {
        btnDonateSubmit.disabled = false;
        btnDonateSubmit.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l8.78-8.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path></svg><span>Kirim Donasi via QRIS</span>';
      }
    });
  }

  // --- AUTOMATIC BASE URL DETECTION ---
  const currentBaseUrl = window.location.origin;
  const apiBaseUrlElem = document.getElementById('apiBaseUrl');
  if (apiBaseUrlElem) {
    apiBaseUrlElem.textContent = currentBaseUrl;
  }

  const btnCopyBaseUrl = document.getElementById('btnCopyBaseUrl');
  if (btnCopyBaseUrl) {
    btnCopyBaseUrl.addEventListener('click', () => {
      navigator.clipboard.writeText(currentBaseUrl);
      showToast('Base URL berhasil disalin: ' + currentBaseUrl);
    });
  }

  // --- AUDIO SOUND CHIME ---
  function playSuccessChime() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc1 = ctx.createOscillator();
      const osc2 = ctx.createOscillator();
      const gain = ctx.createGain();

      osc1.type = 'sine';
      osc2.type = 'sine';

      osc1.frequency.setValueAtTime(523.25, ctx.currentTime);
      osc1.frequency.setValueAtTime(783.99, ctx.currentTime + 0.15);

      osc2.frequency.setValueAtTime(659.25, ctx.currentTime);
      osc2.frequency.setValueAtTime(1046.50, ctx.currentTime + 0.15);

      gain.gain.setValueAtTime(0.3, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.6);

      osc1.connect(gain);
      osc2.connect(gain);
      gain.connect(ctx.destination);

      osc1.start();
      osc2.start();
      osc1.stop(ctx.currentTime + 0.6);
      osc2.stop(ctx.currentTime + 0.6);
    } catch (e) {
      console.log('Audio context not available:', e);
    }
  }

  // --- TOAST ALERT ---
  function showToast(message) {
    const toast = document.createElement('div');
    toast.className = 'toast-alert';
    toast.innerHTML = `
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg>
      <span>${message}</span>
    `;
    document.body.appendChild(toast);
    setTimeout(() => {
      toast.remove();
    }, 4000);
  }

  // --- 1. DYNAMIC QRIS FORM SUBMISSION ---
  const qrisForm = document.getElementById('qrisForm');
  const btnGenerate = document.getElementById('btnGenerate');
  const autoUniqueCheckbox = document.getElementById('autoUnique');
  const uniqueCodeInput = document.getElementById('uniqueCode');

  if (autoUniqueCheckbox) {
    autoUniqueCheckbox.addEventListener('change', () => {
      uniqueCodeInput.disabled = autoUniqueCheckbox.checked;
      if (autoUniqueCheckbox.checked) {
        uniqueCodeInput.placeholder = "Otomatis acak sistem";
      } else {
        uniqueCodeInput.placeholder = "Contoh: 338";
      }
    });
  }

  if (qrisForm) {
    qrisForm.addEventListener('submit', async (e) => {
      e.preventDefault();

      const baseAmount = document.getElementById('baseAmount').value;
      const uniqueCode = uniqueCodeInput.value;
      const autoUnique = autoUniqueCheckbox ? autoUniqueCheckbox.checked : true;
      const payloadStatic = document.getElementById('payloadStatic').value;

      btnGenerate.disabled = true;
      btnGenerate.innerHTML = '<span>Memproses QRIS...</span>';

      try {
        const response = await fetch('/api/qris/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            base_amount: baseAmount,
            unique_code: uniqueCode,
            auto_unique: autoUnique,
            payload_static: payloadStatic
          })
        });

        const data = await response.json();

        if (!data.ok) {
          alert('Gagal: ' + (data.message || 'Terjadi kesalahan'));
          return;
        }

        const inv = data.invoice;
        activeInvoiceId = inv.id;

        // Update UI Display
        document.getElementById('invoiceIdLabel').textContent = inv.id;
        document.getElementById('qrImage').src = inv.qr_png_data_url || 'https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=' + encodeURIComponent(inv.payload || 'DEMO');
        document.getElementById('totalAmountLabel').textContent = `Rp ${inv.total_amount.toLocaleString('id-ID')}`;
        document.getElementById('baseAmountLabel').textContent = `Rp ${inv.base_amount.toLocaleString('id-ID')}`;
        document.getElementById('uniqueCodeLabel').textContent = `${inv.unique_code}`;
        
        const badge = document.getElementById('invoiceBadge');
        badge.className = 'badge badge-pending';
        badge.textContent = 'PENDING';

        // Prefill Webhook Simulator amount
        document.getElementById('simAmount').value = inv.total_amount;
        document.getElementById('simPayload').value = JSON.stringify({ message: `Pembayaran masuk Rp ${inv.total_amount.toLocaleString('id-ID')} dari ShopeePay` }, null, 2);

        // Start Polling & Timer
        startStatusPolling(inv.id);
        startCountdownTimer(15 * 60);
        loadHistoryData();

      } catch (err) {
        console.error(err);
        alert('Gagal terhubung ke server');
      } finally {
        btnGenerate.disabled = false;
        btnGenerate.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg><span>Generate Gambar QRIS</span>';
      }
    });
  }

  // --- STATUS POLLING & TIMER ---
  function startStatusPolling(invoiceId) {
    if (pollInterval) clearInterval(pollInterval);

    pollInterval = setInterval(async () => {
      try {
        const res = await fetch(`/api/invoices/${invoiceId}`);
        const data = await res.json();

        if (data.ok && data.invoice) {
          const inv = data.invoice;
          if (inv.status === 'PAID') {
            clearInterval(pollInterval);
            clearInterval(timerInterval);

            const badge = document.getElementById('invoiceBadge');
            badge.className = 'badge badge-paid';
            badge.textContent = 'LUNAS (PAID)';

            playSuccessChime();
            showToast(`PEMBAYARAN BERHASIL! Invoice ${inv.id} LUNAS via ${inv.payment_source || 'QRIS'}`);
            loadHistoryData();
          }
        }
      } catch (err) {
        console.error('Polling error:', err);
      }
    }, 2000);
  }

  function startCountdownTimer(seconds) {
    if (timerInterval) clearInterval(timerInterval);
    let remaining = seconds;
    const timerElem = document.getElementById('timerCountdown');

    timerInterval = setInterval(() => {
      remaining--;
      if (remaining <= 0) {
        clearInterval(timerInterval);
        clearInterval(pollInterval);
        timerElem.textContent = 'EXPIRED';
        const badge = document.getElementById('invoiceBadge');
        badge.className = 'badge badge-expired';
        badge.textContent = 'EXPIRED';
        return;
      }
      const mins = Math.floor(remaining / 60);
      const secs = remaining % 60;
      timerElem.textContent = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    }, 1000);
  }

  // --- 2. WEBHOOK SIMULATOR ---
  const simulatorForm = document.getElementById('simulatorForm');
  const simResultCard = document.getElementById('simResultCard');
  const simResultJson = document.getElementById('simResultJson');

  if (simulatorForm) {
    simulatorForm.addEventListener('submit', async (e) => {
      e.preventDefault();

      const payloadText = document.getElementById('simPayload').value;

      try {
        let bodyData;
        try {
          bodyData = JSON.parse(payloadText);
        } catch (e) {
          bodyData = payloadText;
        }

        const response = await fetch('/api/webhook/callback', {
          method: 'POST',
          headers: { 'Content-Type': typeof bodyData === 'object' ? 'application/json' : 'text/plain' },
          body: typeof bodyData === 'object' ? JSON.stringify(bodyData) : bodyData
        });

        const data = await response.json();
        simResultJson.textContent = JSON.stringify(data, null, 2);
        simResultCard.style.display = 'block';

        if (data.matched_invoice) {
          showToast(data.message);
        }
        loadHistoryData();

      } catch (err) {
        alert('Error pengiriman simulator: ' + err.message);
      }
    });
  }

  // --- 3. TRANSACTION HISTORY LOADING ---
  const btnRefreshHistory = document.getElementById('btnRefreshHistory');
  const invoiceTableBody = document.getElementById('invoiceTableBody');
  const webhookLogBody = document.getElementById('webhookLogBody');

  if (btnRefreshHistory) {
    btnRefreshHistory.addEventListener('click', loadHistoryData);
  }

  async function loadHistoryData() {
    try {
      // Invoices
      const invRes = await fetch('/api/invoices');
      const invData = await invRes.json();

      if (invData.ok && invData.invoices.length > 0 && invoiceTableBody) {
        invoiceTableBody.innerHTML = invData.invoices.map(inv => `
          <tr>
            <td><strong>${inv.id}</strong></td>
            <td>${new Date(inv.created_at).toLocaleTimeString('id-ID')}</td>
            <td>Rp ${inv.base_amount.toLocaleString('id-ID')}</td>
            <td style="color: var(--accent-indigo); font-weight: 700;">${inv.unique_code}</td>
            <td><strong style="color: var(--text-primary);">Rp ${inv.total_amount.toLocaleString('id-ID')}</strong></td>
            <td><span class="badge badge-${inv.status.toLowerCase()}">${inv.status}</span></td>
          </tr>
        `).join('');
      }

      // Webhook Logs
      const logRes = await fetch('/api/webhook/logs');
      const logData = await logRes.json();

      if (logData.ok && logData.logs.length > 0 && webhookLogBody) {
        webhookLogBody.innerHTML = logData.logs.map(log => `
          <tr>
            <td>${new Date(log.received_at).toLocaleTimeString('id-ID')}</td>
            <td><code>${typeof log.raw_payload === 'object' ? JSON.stringify(log.raw_payload) : log.raw_payload}</code></td>
            <td><strong style="color: var(--accent-indigo);">Rp ${(log.extracted_amount || 0).toLocaleString('id-ID')}</strong></td>
            <td><span class="badge badge-${log.status === 'MATCHED' ? 'paid' : 'expired'}">${log.status}</span></td>
          </tr>
        `).join('');
      }

    } catch (err) {
      console.error('Error loading history:', err);
    }
  }

  // Initial load
  loadHistoryData();

  // --- 4. QR DECODER (DRAG & DROP FILE) ---
  const dropZone = document.getElementById('dropZone');
  const fileInput = document.getElementById('fileInput');
  const decodeResultArea = document.getElementById('decodeResultArea');
  const decodedString = document.getElementById('decodedString');

  if (dropZone) {
    dropZone.addEventListener('click', () => fileInput.click());

    dropZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropZone.style.borderColor = 'var(--accent-indigo)';
    });

    dropZone.addEventListener('dragleave', () => {
      dropZone.style.borderColor = '#cbd5e1';
    });

    dropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropZone.style.borderColor = '#cbd5e1';
      if (e.dataTransfer.files.length > 0) {
        handleImageDecode(e.dataTransfer.files[0]);
      }
    });

    if (fileInput) {
      fileInput.addEventListener('change', () => {
        if (fileInput.files.length > 0) {
          handleImageDecode(fileInput.files[0]);
        }
      });
    }
  }

  async function handleImageDecode(file) {
    const reader = new FileReader();
    reader.onload = async (e) => {
      const base64 = e.target.result;

      try {
        const response = await fetch('/api/qris/decode', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ image_base64: base64 })
        });

        const data = await response.json();
        decodedString.textContent = data.payload || JSON.stringify(data, null, 2);
        decodeResultArea.style.display = 'block';

        if (data.payload) {
          document.getElementById('payloadStatic').value = data.payload;
        }

      } catch (err) {
        alert('Gagal mendecode QR Code: ' + err.message);
      }
    };
    reader.readAsDataURL(file);
  }

  // --- CLIPBOARD COPY HELPER ---
  const btnCopyPayload = document.getElementById('btnCopyPayload');
  if (btnCopyPayload) {
    btnCopyPayload.addEventListener('click', () => {
      navigator.clipboard.writeText(decodedString.textContent);
      showToast('Payload string berhasil disalin!');
    });
  }

});
