// Hot-plug proof of concept: attaches a host directory to a running
// qemu-backend session's VM, keeps it mounted until Ctrl-C, then unmounts
// and detaches it (see server/ws/qemuShares.js).
//
// Usage: node server/cli/qemu-share-poc.js <VM run dir> <host dir> [guest path]
//   The run dir is the session's qemuRunDir (GET /vms, or
//   ~/.local/share/ccserver-sandbox/qemu/run/<id>). The guest path defaults
//   to the host dir's own path.

import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { buildVirtiofsdArgs } from '../ws/sandbox-qemu.js';
import { openHotplugShares } from '../ws/qemuShares.js';

const [runDir, hostDirArg, guestPathArg] = process.argv.slice(2);
if (!runDir || !hostDirArg) {
  console.error('使い方: node server/cli/qemu-share-poc.js <VMのrunディレクトリ> <ホストのディレクトリ> [ゲストのパス]');
  process.exit(2);
}

const plan = JSON.parse(readFileSync(join(runDir, 'plan.json'), 'utf-8'));
if (!plan.hotplug) {
  console.error('この VM はホットプラグ対応前の plan で起動しています。セッションを起動し直してください。');
  process.exit(1);
}
const hostDir = realpathSync(hostDirArg);
const guestPath = guestPathArg || hostDir;

const shares = await openHotplugShares(plan, { buildVirtiofsdArgs });
let t = Date.now();
const lease = await shares.acquire(hostDir, { guestPath });
console.log(`マウントしました: ${hostDir} -> ${guestPath} (${Date.now() - t} ms)`);
console.log(shares.list());
console.log('Ctrl-C でアンマウントします。');

await new Promise((resolve) => { process.once('SIGINT', resolve); process.once('SIGTERM', resolve); });
t = Date.now();
await lease.release();
console.log(`アンマウントしました (${Date.now() - t} ms)`);
await shares.close();
