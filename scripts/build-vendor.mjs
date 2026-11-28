import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PUBLIC_VENDOR = path.join(ROOT, 'public', 'vendor');
const DIST_VENDOR = path.join(ROOT, 'dist', 'vendor');
const THREE_BUILD = path.join(ROOT, 'node_modules', 'three', 'build');

fs.mkdirSync(PUBLIC_VENDOR, { recursive: true });
fs.mkdirSync(DIST_VENDOR, { recursive: true });

const sharedBuildOpts = {
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  define: {
    global: 'globalThis',
    'process.env.NODE_ENV': '"production"',
  },
};

const entries = [
  { in: 'src/client/solana-web3.ts', out: 'solana-web3.js' },
  { in: 'src/client/coinbase-sdk.ts', out: 'coinbase-sdk.js' },
  { in: 'src/client/walletconnect-sdk.ts', out: 'walletconnect-sdk.js' },
  { in: 'src/client/wallet-sdks.ts', out: 'wallet-sdks.js' },
  { in: 'src/client/gsap-vendor.ts', out: 'gsap.js' },
];

await Promise.all(
  entries.map(async (entry) => {
    const outFile = path.join(PUBLIC_VENDOR, entry.out);
    await build({
      ...sharedBuildOpts,
      entryPoints: [path.join(ROOT, entry.in)],
      outfile: outFile,
    });
    const sizeKb = (fs.statSync(outFile).size / 1024).toFixed(1);
    console.log(`  public/vendor/${entry.out}  ${sizeKb}kb`);
  })
);

// Keep dist/vendor/wallet-sdks.js mirror for backwards-compatible local tooling
fs.copyFileSync(
  path.join(PUBLIC_VENDOR, 'wallet-sdks.js'),
  path.join(DIST_VENDOR, 'wallet-sdks.js')
);

// Emit minified Three.js ESM modules directly into public/vendor/ so Vercel serves them via Edge CDN
const threeCoreSrc = path.join(THREE_BUILD, 'three.core.min.js');
const threeModSrc = path.join(THREE_BUILD, 'three.module.min.js');
if (fs.existsSync(threeCoreSrc) && fs.existsSync(threeModSrc)) {
  const coreOut = path.join(PUBLIC_VENDOR, 'three.core.js');
  const modOut = path.join(PUBLIC_VENDOR, 'three.module.js');
  fs.copyFileSync(threeCoreSrc, coreOut);
  const modSource = fs
    .readFileSync(threeModSrc, 'utf8')
    .replaceAll('./three.core.min.js', './three.core.js');
  fs.writeFileSync(modOut, modSource, 'utf8');
  console.log(
    `  public/vendor/three.module.js  ${(fs.statSync(modOut).size / 1024).toFixed(1)}kb (minified)`
  );
  console.log(
    `  public/vendor/three.core.js  ${(fs.statSync(coreOut).size / 1024).toFixed(1)}kb (minified)`
  );
}
