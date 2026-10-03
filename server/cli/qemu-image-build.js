// Builds the "golden" VM image that every qemu-backend session boots from
// (see server/ws/sandbox-qemu.js). One-off and offline-safe to rerun:
//
//   1. download Debian's genericcloud image (cached) and verify it against
//      Debian's SHA512SUMS
//   2. boot it once under KVM with open networking and a build-only
//      cloud-init seed that installs GOLDEN_PACKAGES and hardens sshd, then
//      powers off
//   3. flatten the result into images/golden-<version>.qcow2 and point
//      images/current.json at it
//
// The version is a hash of the base image checksum and the build recipe,
// so an unchanged recipe skips the build unless --force is given.
//
// Usage: node server/cli/qemu-image-build.js [--force]

import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { join } from 'node:path';
import {
  BASE_IMAGE, GOLDEN_OK_MARKER, QEMU_IMG, QEMU_SYSTEM,
  buildGoldenUserData, currentGolden, goldenDir, goldenVersion, qemuRoot,
} from '../ws/sandbox-qemu.js';

const args = process.argv.slice(2);
const unknown = args.filter((a) => a !== '--force');
if (unknown.length > 0) {
  console.error(`不明な引数: ${unknown.join(' ')}`);
  console.error('使い方: node server/cli/qemu-image-build.js [--force]');
  process.exit(2);
}
const force = args.includes('--force');
const BUILD_TIMEOUT_MS = 30 * 60 * 1000;

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.text();
}

async function sha512File(path) {
  const h = createHash('sha512');
  await pipeline(createReadStream(path), h);
  return h.digest('hex');
}

async function ensureBaseImage() {
  const cacheDir = join(qemuRoot(), 'cache');
  mkdirSync(cacheDir, { recursive: true });
  const sums = await fetchText(BASE_IMAGE.sumsUrl);
  const line = sums.split('\n').find((l) => l.trim().endsWith(` ${BASE_IMAGE.name}`));
  const expected = line?.trim().split(/\s+/)[0];
  if (!expected || !/^[0-9a-f]{128}$/.test(expected)) throw new Error(`SHA512SUMS に ${BASE_IMAGE.name} がありません`);
  const path = join(cacheDir, BASE_IMAGE.name);
  if (existsSync(path) && await sha512File(path) === expected) {
    console.log(`ベースイメージ: キャッシュを使用 (${path})`);
    return { path, sha512: expected };
  }
  console.log(`ベースイメージをダウンロード中: ${BASE_IMAGE.url}`);
  const tmp = `${path}.part-${randomUUID()}`;
  const res = await fetch(BASE_IMAGE.url);
  if (!res.ok || !res.body) throw new Error(`${BASE_IMAGE.url}: HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp));
  const got = await sha512File(tmp);
  if (got !== expected) {
    rmSync(tmp, { force: true });
    throw new Error('ベースイメージの SHA512 が一致しません (ダウンロード破損または改ざん)');
  }
  renameSync(tmp, path);
  return { path, sha512: expected };
}

function runBuildVm(workDir, overlay, seedDir) {
  const consoleLog = join(workDir, 'console.log');
  const qemuArgs = [
    '-nodefaults', '-no-user-config',
    '-machine', 'q35,accel=kvm', '-cpu', 'host', '-smp', '2', '-m', '2048M',
    '-drive', `file=${overlay},if=virtio,format=qcow2,cache=unsafe`,
    '-drive', `if=virtio,format=raw,readonly=on,file.driver=vvfat,file.dir=${seedDir},file.label=CIDATA`,
    '-device', 'virtio-rng-pci',
    '-device', 'VGA', // see buildQemuArgs: no display adapter -> boot loop
    '-netdev', 'user,id=n0', '-device', 'virtio-net-pci,netdev=n0',
    '-display', 'none', '-serial', `file:${consoleLog}`,
  ];
  return new Promise((resolve, reject) => {
    const proc = spawn(QEMU_SYSTEM, qemuArgs, { stdio: ['ignore', 'inherit', 'inherit'] });
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`ビルド用 VM が ${BUILD_TIMEOUT_MS / 60000} 分以内に終了しませんでした (${consoleLog})`));
    }, BUILD_TIMEOUT_MS);
    proc.on('error', (e) => { clearTimeout(timer); reject(e); });
    proc.on('exit', (code) => {
      clearTimeout(timer);
      const log = existsSync(consoleLog) ? readFileSync(consoleLog, 'utf-8') : '';
      if (!log.includes(GOLDEN_OK_MARKER)) {
        reject(new Error(`イメージ構築が完了しませんでした (qemu exit ${code})。ログ: ${consoleLog}`));
        return;
      }
      resolve();
    });
  });
}

async function main() {
  const base = await ensureBaseImage();
  const version = goldenVersion(base.sha512);
  const cur = currentGolden();
  if (cur?.version === version && !force) {
    console.log(`ゴールデンイメージは最新です: ${cur.path} (version ${version})`);
    return;
  }
  const outDir = goldenDir();
  mkdirSync(outDir, { recursive: true });
  const workDir = join(qemuRoot(), `build-${randomUUID()}`);
  const seedDir = join(workDir, 'seed');
  mkdirSync(seedDir, { recursive: true, mode: 0o700 });
  try {
    writeFileSync(join(seedDir, 'meta-data'), `instance-id: ccs-build-${version}\nlocal-hostname: ccs-build\n`);
    writeFileSync(join(seedDir, 'user-data'), buildGoldenUserData());
    const overlay = join(workDir, 'build.qcow2');
    execFileSync(QEMU_IMG, ['create', '-q', '-f', 'qcow2', '-F', 'qcow2', '-b', base.path, overlay, '8G']);
    console.log('ビルド用 VM を起動中 (パッケージ導入後に自動で停止します。数分かかります)...');
    const t0 = Date.now();
    await runBuildVm(workDir, overlay, seedDir);
    console.log(`VM の構築が完了しました (${Math.round((Date.now() - t0) / 1000)} 秒)。イメージを書き出し中...`);
    const file = `golden-${version}.qcow2`;
    const tmpOut = join(outDir, `.${file}.part`);
    execFileSync(QEMU_IMG, ['convert', '-q', '-O', 'qcow2', overlay, tmpOut]);
    renameSync(tmpOut, join(outDir, file));
    const meta = { version, file, baseImage: BASE_IMAGE.name, baseSha512: base.sha512, builtAt: new Date().toISOString() };
    writeFileSync(join(outDir, 'current.json.tmp'), `${JSON.stringify(meta, null, 2)}\n`);
    renameSync(join(outDir, 'current.json.tmp'), join(outDir, 'current.json'));
    console.log(`完了: ${join(outDir, file)} (version ${version})`);
    if (cur && cur.file !== file) console.log(`以前のイメージ ${cur.path} は不要になりました (稼働中のセッションが無ければ削除できます)。`);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(`エラー: ${e.message}`);
  process.exit(1);
});
