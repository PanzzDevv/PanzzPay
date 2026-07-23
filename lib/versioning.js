const MAX_VERSION_CODE = 2_100_000_000;

export function parseReleaseVersion(tag) {
  const match = String(tag || '').trim().match(/^v?(\d+)\.(\d+)\.(\d+)$/i);
  if (!match) return null;

  const [, majorRaw, minorRaw, patchRaw] = match;
  const major = Number(majorRaw);
  const minor = Number(minorRaw);
  const patch = Number(patchRaw);
  if (![major, minor, patch].every(Number.isSafeInteger)) return null;
  if (major < 0 || minor < 0 || minor > 99 || patch < 0 || patch > 9_999) return null;

  const versionCode = major * 1_000_000 + minor * 10_000 + patch;
  if (versionCode < 1 || versionCode > MAX_VERSION_CODE) return null;

  return {
    versionCode,
    versionName: `${major}.${minor}.${patch}`
  };
}
