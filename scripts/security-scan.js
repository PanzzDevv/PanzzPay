import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

const root = path.resolve(import.meta.dirname, '..');
const ignoredFiles = new Set(['.env.example', 'firebase-config.example.json', 'security-scan.js']);
const rules = [
  { name: 'private key', pattern: /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/ },
  { name: 'legacy admin password', pattern: /adminpanzzpay123/i },
  { name: 'legacy master API key', pattern: /pz_admin_master_key_99999/i },
  { name: 'legacy master webhook token', pattern: /pz_wh_admin_master_token_99999/i },
  { name: 'hardcoded Android keystore password', pattern: /(?:storePassword|keyPassword)\s+['"][^'"]+['"]/ },
  { name: 'browser auth state persisted in Web Storage', pattern: /\b(?:localStorage|sessionStorage)\b/ }
];
const extensions = new Set(['.js', '.json', '.html', '.md', '.yml', '.yaml', '.kt', '.properties']);
const findings = [];

const repositoryFiles = execFileSync(
  'git',
  ['ls-files', '--cached', '--others', '--exclude-standard'],
  { cwd: root, encoding: 'utf8' }
).split(/\r?\n/).filter(Boolean);

for (const relativePath of repositoryFiles) {
  const fileName = path.basename(relativePath);
  const fullPath = path.join(root, relativePath);
  if (!fs.existsSync(fullPath)) continue;
  if (/\.(?:keystore|jks)$/i.test(fileName)) {
    findings.push(`${relativePath}: Android signing key committed to repository`);
    continue;
  }
  if (ignoredFiles.has(fileName) || !extensions.has(path.extname(fileName))) continue;
  const content = fs.readFileSync(fullPath, 'utf8');
  if (path.extname(fileName) === '.html') {
    if (/<script(?![^>]*\bsrc=)[^>]*>/i.test(content)) {
      findings.push(`${relativePath}: inline script bypasses strict CSP`);
    }
    if (/\son(?:click|error|load)\s*=/i.test(content)) {
      findings.push(`${relativePath}: inline event handler bypasses strict CSP`);
    }
  }
  rules.forEach(rule => {
    if (rule.pattern.test(content)) findings.push(`${relativePath}: ${rule.name}`);
  });
}

if (findings.length) {
  console.error(`Security scan gagal:\n${findings.join('\n')}`);
  process.exitCode = 1;
} else {
  console.log('Security scan lulus: tidak ada credential produksi yang terdeteksi.');
}
