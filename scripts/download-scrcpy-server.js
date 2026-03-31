/**
 * Downloads the scrcpy-server binary from GitHub releases.
 * Usage: node scripts/download-scrcpy-server.js [version]
 */
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import https from 'https';

const __dirname = dirname(fileURLToPath(import.meta.url));
const VERSION = process.argv[2] || '2.7';
const URL = `https://github.com/Genymobile/scrcpy/releases/download/v${VERSION}/scrcpy-server-v${VERSION}`;
const OUT_DIR = join(__dirname, '..', 'scrcpy');
const OUT_FILE = join(OUT_DIR, 'scrcpy-server.jar');

function download(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      // Follow redirects (GitHub releases use 302)
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return download(res.headers.location).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

async function main() {
  if (existsSync(OUT_FILE)) {
    console.log(`scrcpy-server already exists at ${OUT_FILE}`);
    console.log('Delete it first to re-download.');
    return;
  }

  if (!existsSync(OUT_DIR)) {
    mkdirSync(OUT_DIR, { recursive: true });
  }

  console.log(`Downloading scrcpy-server v${VERSION}...`);
  console.log(`URL: ${URL}`);

  const data = await download(URL);
  writeFileSync(OUT_FILE, data);
  console.log(`Saved to ${OUT_FILE} (${(data.length / 1024).toFixed(1)} KB)`);
}

main().catch((err) => {
  console.error('Download failed:', err.message);
  process.exit(1);
});
