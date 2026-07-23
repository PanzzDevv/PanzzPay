(() => {
  'use strict';
  const byId = id => document.getElementById(id);

  async function request(url, options = {}) {
    const response = await fetch(url, {
      credentials: 'same-origin',
      ...options,
      headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) }
    });
    const data = await response.json().catch(() => ({ ok: false, message: 'Respons server tidak valid.' }));
    if (!response.ok) throw Object.assign(new Error(data.message || 'Request gagal.'), { status: response.status });
    return data;
  }

  function showLogin() {
    byId('superAdminLoginSection').style.display = 'block';
    byId('superAdminDashboardSection').style.display = 'none';
  }

  async function showDashboard() {
    byId('superAdminLoginSection').style.display = 'none';
    byId('superAdminDashboardSection').style.display = 'block';
    await Promise.all([loadStats(), loadMerchants()]);
  }

  async function loadStats() {
    const data = await request('/api/superadmin/stats');
    byId('statGlobalOmset').textContent = `Rp ${Number(data.stats.total_platform_omset || 0).toLocaleString('id-ID')}`;
    byId('statTotalMerchants').textContent = String(data.stats.total_merchants || 0);
    byId('statTotalPaidInv').textContent = String(data.stats.total_paid_invoices || 0);
  }

  function addCell(row, value) {
    const cell = document.createElement('td');
    cell.textContent = value;
    row.appendChild(cell);
  }

  async function loadMerchants() {
    const data = await request('/api/superadmin/merchants');
    const body = byId('merchantListBody');
    body.replaceChildren();
    data.merchants.forEach(merchant => {
      const row = document.createElement('tr');
      addCell(row, merchant.id);
      addCell(row, merchant.name);
      addCell(row, merchant.email);
      addCell(row, merchant.role);
      addCell(row, `Rp ${Number(merchant.total_omset || 0).toLocaleString('id-ID')}`);
      addCell(row, merchant.status);
      const action = document.createElement('td');
      if (merchant.role !== 'superadmin') {
        const button = document.createElement('button');
        button.className = 'btn btn-dark';
        button.textContent = merchant.status === 'SUSPENDED' ? 'Aktifkan' : 'Tangguhkan';
        button.addEventListener('click', async () => {
          if (!window.confirm(`Ubah status ${merchant.name}?`)) return;
          await request(`/api/superadmin/merchants/${encodeURIComponent(merchant.id)}/toggle-status`, {
            method: 'POST', body: JSON.stringify({ status: merchant.status === 'SUSPENDED' ? 'ACTIVE' : 'SUSPENDED' })
          });
          await loadMerchants();
        });
        action.appendChild(button);
      } else {
        action.textContent = '-';
      }
      row.appendChild(action);
      body.appendChild(row);
    });
  }

  document.addEventListener('DOMContentLoaded', async () => {
    byId('superAdminLoginForm')?.addEventListener('submit', async event => {
      event.preventDefault();
      try {
        const data = await request('/api/auth/login', {
          method: 'POST',
          body: JSON.stringify({ email: byId('saEmail').value.trim(), password: byId('saPassword').value })
        });
        if (data.merchant.role !== 'superadmin') {
          await request('/api/auth/logout', { method: 'POST', body: '{}' });
          throw new Error('Akun ini bukan Super Admin.');
        }
        await showDashboard();
      } catch (error) {
        window.alert(error.message);
      }
    });
    byId('btnSaLogout')?.addEventListener('click', async () => {
      await request('/api/auth/logout', { method: 'POST', body: '{}' }).catch(() => {});
      showLogin();
    });
    try {
      const data = await request('/api/auth/me');
      if (data.merchant.role !== 'superadmin') throw new Error('Bukan admin');
      await showDashboard();
    } catch {
      showLogin();
    }
  });
})();
