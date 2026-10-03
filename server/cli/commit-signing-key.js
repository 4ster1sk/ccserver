// Host-side management of the commit signing key (commitSigning.js), for
// the operator at the host's own shell -- the natural place to import a
// subkey exported from a master key that never touches the browser. Same
// "no HTTP" posture as issue-login-token.js; works with the server up or
// down (it only touches the signing GNUPGHOME and the DB).
//
// Usage:
//   node server/cli/commit-signing-key.js status
//   node server/cli/commit-signing-key.js import <file|->   (output of
//       gpg --armor --export-secret-subkeys <KEYID>!)
//   node server/cli/commit-signing-key.js export-public     (for GitHub)
//   node server/cli/commit-signing-key.js delete [--yes]
//
// delete without --yes only prints what would be removed. A running server
// that had the key unlocked loses it at once (the agent is stopped).

import { readFileSync } from 'node:fs';
import { initDb } from '../db.js';
import * as signing from '../commitSigning.js';
import { deletePasskeyWraps, deleteWrapsForOtherKeys } from '../commitSigningDb.js';

const USAGE = '使い方: node server/cli/commit-signing-key.js status | import <file|-> | export-public | delete [--yes]';
const [command, ...rest] = process.argv.slice(2);

function usage(message) {
  if (message) console.error(message);
  console.error(USAGE);
  process.exit(2);
}

function describe(key) {
  console.log(`署名鍵: ${key.nameReal} <${key.nameEmail}>`);
  console.log(`  署名に使う鍵:  ${key.signingFingerprint}${key.usesSubkey ? ' (サブキー)' : ' (主鍵)'}`);
  console.log(`  主鍵:          ${key.primaryFingerprint}`);
  console.log(`  有効期限:      ${key.expiresAt ? new Date(key.expiresAt).toISOString().slice(0, 10) : 'なし'}`);
  if (key.primarySecretPresent) {
    console.log('  注意: 主鍵の秘密鍵もこのホストにあります。主鍵はオフラインに置き、');
    console.log('        gpg --export-secret-subkeys で書き出したサブキーだけを入れることを推奨します。');
  }
}

async function main() {
  switch (command) {
    case 'status': {
      if (rest.length) usage(`不明な引数: ${rest.join(' ')}`);
      const status = await signing.getSigningStatus();
      console.log(`GNUPGHOME: ${signing.signingHome()}`);
      if (!status.toolsAvailable) { console.log('gpg / gpgconf / gpg-connect-agent が見つかりません。'); return 1; }
      if (status.error) { console.log(`鍵が使えません: ${status.error}`); return 1; }
      if (!status.configured) { console.log('署名鍵は設定されていません。'); return 0; }
      describe(status.key);
      console.log(`  状態:          ${status.unlocked ? 'アンロック済み' : 'ロック中'}`);
      return 0;
    }
    case 'import': {
      if (rest.length !== 1) usage('import には鍵ファイル (- で標準入力) を1つ指定してください');
      const data = readFileSync(rest[0] === '-' ? 0 : rest[0]);
      initDb();
      const key = await signing.importSigningKey(data);
      data.fill(0);
      deleteWrapsForOtherKeys(key.signingFingerprint);
      console.log('インポートしました。');
      describe(key);
      console.log('公開鍵 (export-public) を GitHub の Settings > SSH and GPG keys に登録してください。');
      return 0;
    }
    case 'export-public': {
      if (rest.length) usage(`不明な引数: ${rest.join(' ')}`);
      const pub = await signing.exportPublicKey();
      if (!pub) { console.error('署名鍵は設定されていません。'); return 1; }
      process.stdout.write(pub);
      return 0;
    }
    case 'delete': {
      const unknown = rest.filter((a) => a !== '--yes');
      if (unknown.length) usage(`不明な引数: ${unknown.join(' ')}`);
      const key = await signing.getSigningKey().catch(() => null);
      if (!key && !(await signing.getSigningStatus()).error) {
        console.log('署名鍵は設定されていません。削除するものはありません。');
        return 0;
      }
      if (key) describe(key);
      if (!rest.includes('--yes')) {
        console.log(`--yes を付けると ${signing.signingHome()} を削除します (鍵のバックアップは取りません)。`);
        return 0;
      }
      await signing.deleteSigningKey();
      initDb();
      deletePasskeyWraps();
      console.log('削除しました。サブキーを失効させる場合は、主鍵のある環境で gpg --edit-key から revkey してください。');
      return 0;
    }
    default:
      usage(command ? `不明なコマンド: ${command}` : null);
  }
  return 2;
}

main().then((code) => process.exit(code)).catch((err) => {
  console.error(`失敗しました: ${err.message}`);
  process.exit(1);
});
