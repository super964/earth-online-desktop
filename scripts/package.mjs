import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const electronPkg = JSON.parse(
  fs.readFileSync(path.join(root, 'node_modules', 'electron', 'package.json'), 'utf8'),
);

// Reuse the Electron runtime that npm already downloaded when possible. This
// keeps packaging offline-friendly and avoids a redundant multi-hundred-MB
// download when GitHub is unreachable.
const zipName = `electron-v${electronPkg.version}-win32-x64.zip`;
const cacheRoots = [
  process.env.ELECTRON_CACHE,
  process.platform === 'win32'
    ? path.join(process.env.LOCALAPPDATA || '', 'electron', 'Cache')
    : path.join(os.homedir(), '.cache', 'electron'),
].filter(Boolean);

let zipDir = null;
for (const cacheRoot of cacheRoots) {
  if (fs.existsSync(path.join(cacheRoot, zipName))) {
    zipDir = cacheRoot;
    break;
  }
  if (!fs.existsSync(cacheRoot)) continue;
  for (const entry of fs.readdirSync(cacheRoot)) {
    const dir = path.join(cacheRoot, entry);
    try {
      if (fs.statSync(dir).isDirectory() && fs.existsSync(path.join(dir, zipName))) {
        zipDir = dir;
        break;
      }
    } catch { /* ignore unreadable cache entries */ }
  }
  if (zipDir) break;
}

const args = [
  '.',
  'Earth Online',
  '--platform=win32',
  '--arch=x64',
  '--out=dist',
  '--overwrite',
  '--asar',
  '--icon=assets/icon.ico',
  `--app-version=${pkg.version}`,
  '--win32metadata.CompanyName=Earth Online',
  '--win32metadata.ProductName=Earth Online',
  '--win32metadata.FileDescription=Earth Online - Real-Time 3D Digital Twin',
  '--ignore=^/dist',
  '--ignore=^/\\.',
  '--ignore=^/node_modules',
  '--ignore=^/scripts',
  '--ignore=^/README\\.txt$',
  '--ignore=^/assets/icon-512\\.png$',
];

if (zipDir) {
  args.push(`--electron-zip-dir=${zipDir}`);
  console.log(`Using cached Electron runtime: ${zipDir}`);
} else {
  console.log('No cached Electron runtime found; the packager will download one.');
}

const packager = path.join(root, 'node_modules', '@electron', 'packager', 'bin', 'electron-packager.mjs');
const result = spawnSync(process.execPath, [packager, ...args], { cwd: root, stdio: 'inherit' });

if (result.status === 0) {
  const readme = path.join(root, 'README.txt');
  const outputDir = path.join(root, 'dist', 'Earth Online-win32-x64');
  if (fs.existsSync(readme) && fs.existsSync(outputDir)) {
    fs.copyFileSync(readme, path.join(outputDir, 'README.txt'));
    console.log('Copied README.txt into the portable build.');
  }
}

process.exit(result.status ?? 1);
