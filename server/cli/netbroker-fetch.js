// Fetches the Go network broker (ccs-netbroker) used by the qemu backend
// from the public Gitea generic package of git.tomadoi.com/4sterisk/
// ccserver-netbroker, at the version and sha256 pinned in
// server/netbroker.version.json, into netbrokerBinDir().
//
// Skips the download when the installed binary already matches the pin.
//
// Usage: node server/cli/netbroker-fetch.js

import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { arch, platform } from 'node:process';
import { netbrokerBin, netbrokerBinDir } from '../ws/netbrokerClient.js';

const GOARCH = { x64: 'amd64', arm64: 'arm64' };

const pin = JSON.parse(readFileSync(new URL('../netbroker.version.json', import.meta.url), 'utf-8'));
const asset = `ccs-netbroker-${platform}-${GOARCH[arch] || arch}`;
const expected = pin.sha256[asset];
if (!expected) {
  console.error(`${asset} は配布されていません (server/netbroker.version.json)`);
  process.exit(1);
}

async function sha256File(path) {
  const h = createHash('sha256');
  await pipeline(createReadStream(path), h);
  return h.digest('hex');
}

const dest = netbrokerBin();
if (existsSync(dest) && await sha256File(dest) === expected) {
  console.log(`ccs-netbroker ${pin.version}: インストール済み (${dest})`);
  process.exit(0);
}

const url = `${pin.baseUrl}/${pin.version}/${asset}`;
console.log(`ダウンロード中: ${url}`);
mkdirSync(netbrokerBinDir(), { recursive: true });
const tmp = `${dest}.part-${randomUUID()}`;
try {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`${url}: HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp));
  if (await sha256File(tmp) !== expected) throw new Error(`${asset} の SHA256 が一致しません (ダウンロード破損または改ざん)`);
  chmodSync(tmp, 0o755);
  renameSync(tmp, dest);
} catch (e) {
  rmSync(tmp, { force: true });
  console.error(e.message);
  process.exit(1);
}
console.log(`ccs-netbroker ${pin.version}: ${dest}`);
