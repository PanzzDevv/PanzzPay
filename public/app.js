document.addEventListener('DOMContentLoaded', () => {

  // --- STATE ---
  let activeInvoiceId = null;
  let pollInterval = null;
  let timerInterval = null;
  let authenticatedMerchant = null;

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
  async function updateAuthUIState() {
    const container = document.getElementById('drawerAuthContainer');
    if (!container) return;
    container.replaceChildren();
    let merchant = null;
    try {
      const response = await fetch('/api/auth/session', { credentials: 'same-origin' });
      if (response.ok) {
        const data = await response.json();
        if (data.authenticated) merchant = data.merchant;
      }
    } catch {}
    authenticatedMerchant = merchant;

    const heroAuthLink = document.getElementById('heroAuthLink');
    if (heroAuthLink) heroAuthLink.hidden = Boolean(merchant);

    const link = document.createElement('a');
    link.href = '/portal.html';
    link.className = 'btn btn-primary';
    link.style.cssText = 'width:100%;text-decoration:none;display:flex;align-items:center;justify-content:center;gap:.5rem;';
    link.textContent = merchant ? `Dashboard ${merchant.name}` : 'Daftar / Login';
    container.appendChild(link);
    if (merchant) {
      const logout = document.createElement('button');
      logout.className = 'btn btn-dark';
      logout.textContent = 'Logout';
      logout.style.width = '100%';
      logout.addEventListener('click', async () => {
        await fetch('/api/auth/logout', {
          method: 'POST', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' }, body: '{}'
        });
        await updateAuthUIState();
        renderHistorySignedOut();
        if (window.location.pathname.includes('portal.html')) window.location.reload();
      });
      container.appendChild(logout);
    }
    return merchant;
  }

  // Initialize Auth state
  const authReady = updateAuthUIState();

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
      btnDonateSubmit.textContent = 'Membuat QRIS Donasi...';

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
        setQrImage(inv.qr_png_data_url || 'https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=' + encodeURIComponent(inv.payload || 'DONATION'));
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
        if (document.getElementById('simAmount')) {
          document.getElementById('simAmount').value = inv.total_amount;
        }
        if (document.getElementById('simPayload')) {
          document.getElementById('simPayload').value = JSON.stringify({ message: `Pembayaran masuk Rp ${inv.total_amount.toLocaleString('id-ID')} dari ShopeePay` }, null, 2);
        }

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
        btnDonateSubmit.textContent = 'Kirim Donasi via QRIS';
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
    btnCopyBaseUrl.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(currentBaseUrl);
        showToast('Base URL berhasil disalin: ' + currentBaseUrl);
      } catch {
        showToast('Base URL belum dapat disalin. Silakan salin manual.');
      }
    });
  }

  function setQrImage(source) {
    const image = document.getElementById('qrImage');
    const placeholder = document.getElementById('qrPlaceholder');
    if (!image) return;
    if (!source) {
      image.hidden = true;
      image.removeAttribute('src');
      if (placeholder) placeholder.hidden = false;
      return;
    }
    image.src = source;
    image.hidden = false;
    if (placeholder) placeholder.hidden = true;
  }

  const qrImage = document.getElementById('qrImage');
  if (qrImage) {
    qrImage.addEventListener('error', () => {
      setQrImage('');
      showToast('Gambar QRIS gagal dimuat. Silakan generate ulang.');
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

  // --- PRO TOAST CONTAINER & ALERT SYSTEM ---
  let lastToastMsg = '';
  let lastToastTime = 0;

  function showToast(message) {
    const now = Date.now();
    if (message === lastToastMsg && (now - lastToastTime < 2000)) {
      return; // prevent duplicate toast within 2 seconds
    }
    lastToastMsg = message;
    lastToastTime = now;

    let container = document.getElementById('toastContainer');
    if (!container) {
      container = document.createElement('div');
      container.id = 'toastContainer';
      container.className = 'toast-container';
      document.body.appendChild(container);
    }

    const toast = document.createElement('div');
    toast.className = 'toast-alert';
    const icon = document.createElement('span');
    icon.textContent = '✓';
    icon.setAttribute('aria-hidden', 'true');
    const content = document.createElement('div');
    content.style.flex = '1';
    content.textContent = String(message);
    toast.append(icon, content);

    container.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(10px) scale(0.95)';
      toast.style.transition = 'all 0.3s ease';
      setTimeout(() => toast.remove(), 300);
    }, 4500);
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

  async function generateQRISAction(baseAmount, uniqueCode, autoUnique) {
    if (btnGenerate) {
      btnGenerate.disabled = true;
      btnGenerate.textContent = 'Memproses QRIS...';
    }

    try {
      const response = await fetch('/api/qris/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          base_amount: baseAmount,
          unique_code: uniqueCode,
          auto_unique: autoUnique
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
      setQrImage(inv.qr_png_data_url || 'https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=' + encodeURIComponent(inv.payload || 'DEMO'));
      document.getElementById('totalAmountLabel').textContent = `Rp ${inv.total_amount.toLocaleString('id-ID')}`;
      document.getElementById('baseAmountLabel').textContent = `Rp ${inv.base_amount.toLocaleString('id-ID')}`;
      document.getElementById('uniqueCodeLabel').textContent = `${inv.unique_code}`;
      
      const badge = document.getElementById('invoiceBadge');
      badge.className = 'badge badge-pending';
      badge.textContent = 'PENDING';

      // Prefill Webhook Simulator amount
      if (document.getElementById('simAmount')) {
        document.getElementById('simAmount').value = inv.total_amount;
      }
      if (document.getElementById('simPayload')) {
        document.getElementById('simPayload').value = JSON.stringify({ message: `Pembayaran masuk Rp ${inv.total_amount.toLocaleString('id-ID')} dari ShopeePay` }, null, 2);
      }

      // Start Polling & Timer
      startStatusPolling(inv.id);
      startCountdownTimer(15 * 60);
      loadHistoryData();

    } catch (err) {
      console.error(err);
    } finally {
      if (btnGenerate) {
        btnGenerate.disabled = false;
        btnGenerate.textContent = 'Generate Gambar QRIS';
      }
    }
  }

  if (qrisForm) {
    qrisForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const baseAmount = document.getElementById('baseAmount').value;
      const uniqueCode = uniqueCodeInput ? uniqueCodeInput.value : '';
      const autoUnique = autoUniqueCheckbox ? autoUniqueCheckbox.checked : true;
      generateQRISAction(baseAmount, uniqueCode, autoUnique);
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
        if (timerElem) timerElem.textContent = 'EXPIRED';
        const badge = document.getElementById('invoiceBadge');
        if (badge) {
          badge.className = 'badge badge-expired';
          badge.textContent = 'EXPIRED';
        }
        return;
      }
      const mins = Math.floor(remaining / 60);
      const secs = remaining % 60;
      if (timerElem) timerElem.textContent = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
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

  function renderHistoryMessage(body, colspan, message) {
    if (!body) return;
    body.replaceChildren();
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = colspan;
    cell.textContent = message;
    cell.style.cssText = 'text-align:center;color:var(--text-muted);padding:1.5rem;';
    row.appendChild(cell);
    body.appendChild(row);
  }

  function renderHistorySignedOut() {
    renderHistoryMessage(invoiceTableBody, 6, 'Masuk ke akun merchant untuk melihat transaksi.');
    renderHistoryMessage(webhookLogBody, 4, 'Masuk ke akun merchant untuk melihat log webhook.');
    if (btnRefreshHistory) btnRefreshHistory.disabled = true;
  }

  async function loadHistoryData() {
    if (!invoiceTableBody && !webhookLogBody) return;
    if (!authenticatedMerchant) {
      renderHistorySignedOut();
      return;
    }
    if (btnRefreshHistory) btnRefreshHistory.disabled = false;
    try {
      // Invoices
      const invRes = await fetch('/api/invoices');
      const invType = invRes.headers.get('content-type') || '';
      if (invRes.ok && invType.includes('application/json')) {
        const invData = await invRes.json();
        if (invData.ok && Array.isArray(invData.invoices) && invoiceTableBody) {
          invoiceTableBody.replaceChildren();
          invData.invoices.forEach(inv => {
            const row = document.createElement('tr');
            const values = [
              String(inv.id || ''),
              new Date(inv.created_at).toLocaleTimeString('id-ID'),
              `Rp ${Number(inv.base_amount || 0).toLocaleString('id-ID')}`,
              String(inv.unique_code || 0),
              `Rp ${Number(inv.total_amount || 0).toLocaleString('id-ID')}`,
              ['PENDING', 'PAID', 'EXPIRED'].includes(inv.status) ? inv.status : 'UNKNOWN'
            ];
            values.forEach(value => {
              const cell = document.createElement('td');
              cell.textContent = value;
              row.appendChild(cell);
            });
            invoiceTableBody.appendChild(row);
          });
          if (!invData.invoices.length) {
            renderHistoryMessage(invoiceTableBody, 6, 'Belum ada transaksi. Generate QRIS pertama Anda.');
          }
        }
      }

      // Webhook Logs
      const logRes = await fetch('/api/webhook/logs');
      const logType = logRes.headers.get('content-type') || '';
      if (logRes.ok && logType.includes('application/json')) {
        const logData = await logRes.json();
        if (logData.ok && Array.isArray(logData.logs) && webhookLogBody) {
          webhookLogBody.replaceChildren();
          logData.logs.forEach(log => {
            const row = document.createElement('tr');
            const values = [
              new Date(log.received_at).toLocaleTimeString('id-ID'),
              String(log.source || 'Webhook'),
              `Rp ${Number(log.extracted_amount || 0).toLocaleString('id-ID')}`,
              log.status === 'MATCHED' ? 'MATCHED' : 'UNMATCHED'
            ];
            values.forEach(value => {
              const cell = document.createElement('td');
              cell.textContent = value;
              row.appendChild(cell);
            });
            webhookLogBody.appendChild(row);
          });
          if (!logData.logs.length) {
            renderHistoryMessage(webhookLogBody, 4, 'Belum ada notifikasi webhook yang diterima.');
          }
        }
      }

    } catch (err) {
      console.error('Error loading history:', err);
    }
  }

  // Initial load only after the session check, avoiding expected 401s for anonymous visitors.
  authReady.then(merchant => {
    if (!invoiceTableBody && !webhookLogBody) return;
    if (merchant) loadHistoryData();
    else renderHistorySignedOut();
  });

  // --- 4. QR DECODER (DRAG & DROP FILE) ---
  const dropZone = document.getElementById('dropZone');
  const fileInput = document.getElementById('fileInput');
  const decodeResultArea = document.getElementById('decodeResultArea');
  const decodedString = document.getElementById('decodedString');

  if (dropZone) {
    dropZone.addEventListener('click', () => fileInput.click());

    dropZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropZone.style.borderColor = 'var(--brand-blue)';
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

        const contentType = response.headers.get('content-type') || '';
        if (!contentType.includes('application/json')) {
          alert('Gagal mendecode QR Code: Server mengembalikan respon non-JSON');
          return;
        }

        const data = await response.json();
        decodedString.textContent = data.payload || JSON.stringify(data, null, 2);
        decodeResultArea.style.display = 'block';

        if (data.payload) {
          document.getElementById('payloadStatic').value = data.payload;
          showToast(data.message || 'Payload string QRIS berhasil diekstrak!');
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
