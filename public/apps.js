(() => {
  'use strict';
  fetch('/api/app/check-update')
    .then(response => response.json())
    .then(data => {
      if (!data?.ok || !data.downloadUrl) return;
      const button = document.getElementById('btnDownloadApk');
      if (!button) return;
      button.href = data.downloadUrl;
      const label = button.querySelector('span');
      if (label && data.versionName) label.textContent = `Unduh File .APK (v${data.versionName} Terbaru)`;
    })
    .catch(() => {});
})();
