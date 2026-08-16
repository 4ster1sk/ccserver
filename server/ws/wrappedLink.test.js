// 回帰テスト: LLM出力のURLが折り返しで「実改行」されたとき、クリックで開くURLが
// 正しくならないバグ。
//
// 背景:
//   opencode の TUI は wrapMode:"word" で独自に折り返しを行うため、幅に収まらない
//   URL を実改行（\r\n）で次の行へ折る。xterm のバッファでは続き行は isWrapped=false
//   （ターミナルのソフトラップではない）となり、@xterm/addon-web-links の
//   WebLinkProvider は isWrapped=true の行しか連結しない。その結果クリック対象の
//   URL は折り返しの先頭行に残った断片になり、正しいURLが開けない。
//
// ここでは client/src/wrappedLinks.js の WrappedLinkProvider（実改行でも行をまたいで
// URLを復元するプロバイダ）を、実際の @xterm/xterm バッファに loadAddon 相当の
// registerLinkProvider で登録し、本番のクリック時に走るのと同じ provideLinks を
// 駆動して検証する。折り返されたURLは常に完全な形で検出されるべき、という期待を固定する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import xtermPkg from '@xterm/xterm';
import { WrappedLinkProvider } from '../../client/src/wrappedLinks.js';

const { Terminal } = xtermPkg;

const PREFIX = '詳しくはこちらをご覧ください ';
// 58 文字。折り返しで切る位置はテストごとに url.slice(...) で作る。
const URL = 'https://example.com/foo/bar/baz/very/long/path?q=1#section';

// 実装ディテールに触れるのはここだけに閉じ込める:
// 公開APIに「どのURLがリンクになるか問い合わせる」手段が無いため、
// registerLinkProvider 済みのプロバイダを内部の linkProviderService から取り出して
// provideLinks を駆動する。
async function findLinks(writeSeq, { cols = 60, rows = 10 } = {}) {
  const term = new Terminal({ cols, rows, scrollback: 1000 });
  term.registerLinkProvider(new WrappedLinkProvider(term));
  await new Promise((resolve) => term.write(writeSeq, resolve));

  const provider = [...term._core._linkProviderService.linkProviders.values()].find(
    (p) => p && typeof p.provideLinks === 'function' && !p._oscLinkService && !p._regex,
  );
  const links = [];
  for (let y = 1; y <= term.rows; y++) {
    await new Promise((resolve) => {
      provider.provideLinks(y, (found) => {
        if (found) links.push(...found);
        resolve();
      });
    });
  }
  term.dispose();
  return links;
}

function uniqueByText(links) {
  const seen = new Set();
  return links.filter((l) => (seen.has(l.text) ? false : (seen.add(l.text), true)));
}

test('1行に収まるURLは完全な形で検出される', async () => {
  const links = await findLinks(`${PREFIX}https://example.com/single`);
  assert.deepEqual(uniqueByText(links).map((l) => l.text), ['https://example.com/single']);
});

test('ターミナルがソフトラップしたURL（isWrapped=true）は行をまたいで結合される', async () => {
  const links = uniqueByText(await findLinks(`${PREFIX}${URL}`));
  assert.deepEqual(links.map((l) => l.text), [URL]);
  // 複数行にまたがる範囲になる
  assert.ok(links[0].range.start.y !== links[0].range.end.y, 'ソフトラップは複数行の範囲になる');
});

test('実改行で折り返されたURL（opencode TUI）は完全な形で再構築される', async () => {
  // opencode の wrapMode:"word" が URL を幅の途中で実改行で折った状態を再現。
  // 1行目は行末まで埋まっている（折り返しで打ち切られた）ことが重要。
  const cut = 31;
  const seq = `${PREFIX}${URL.slice(0, cut)}\r\n${URL.slice(cut)} 残りの文章です`;
  const links = uniqueByText(await findLinks(seq));
  assert.deepEqual(links.map((l) => l.text), [URL], 'クリック対象は完全なURLであるべき');
  // 下線は2行にまたがる
  assert.equal(links[0].range.start.y, 1);
  assert.equal(links[0].range.end.y, 2);
});

test('折り返しの続き行に行頭インデントがあっても完全なURLになる', async () => {
  const cut = 31;
  const seq = `${PREFIX}${URL.slice(0, cut)}\r\n  ${URL.slice(cut)} 残りの文章です`;
  const links = uniqueByText(await findLinks(seq));
  assert.deepEqual(links.map((l) => l.text), [URL], '行頭のインデントはURLの一部に含まれない');
});

test('続き行（2行目）を問い合わせても完全なURLが返る', async () => {
  const cut = 31;
  const seq = `${PREFIX}${URL.slice(0, cut)}\r\n${URL.slice(cut)} 残りの文章です`;
  const all = await findLinks(seq);
  const onRow2 = all.filter((l) => l.range.start.y === 2 || (l.range.end.y === 2 && l.range.start.y < 2));
  assert.ok(onRow2.some((l) => l.text === URL), '続き行をクリックしても完全なURLが開ける');
});

test('opencodeの実レイアウト（絶対カーソル位置指定・内容領域が端末幅より狭い）でも完全なURLになる', async () => {
  // opencode は wrapMode:"word" で折り返す際、実改行ではなく CSI <行>;<列>H の
  // 絶対カーソル位置指定で続き行を書き、かつメッセージ内容領域は端末幅より狭い
  // （左マージン + 右パディング）。折り返し行のセル数は cols より小さくなる。
  const cols = 91;
  const contentWidth = 83;
  const fragLen = contentWidth - 29; // 29 = 前置き '詳しくはこちらをご覧ください ' のセル数
  const seq =
    `\u001b[19;6H${PREFIX}${URL.slice(0, fragLen)}\u001b[0m` +
    `\u001b[20;6H${URL.slice(fragLen)} 残りの文章です\u001b[0m`;
  const links = uniqueByText(await findLinks(seq, { cols, rows: 30 }));
  assert.deepEqual(links.map((l) => l.text), [URL], '実レイアウトでも完全なURLであるべき');
});

test('ソフトラップと実改行が混ざっても完全なURLになる', async () => {
  // 1回目の折り返しはターミナルのソフトラップ、2回目は実改行という混在。
  const seq = `${PREFIX}${URL}-more-more-more-more-more\r\n-rest-end`;
  const links = uniqueByText(await findLinks(seq));
  assert.deepEqual(links.map((l) => l.text), [`${URL}-more-more-more-more-more-rest-end`]);
});

test('意図的な改行（行が埋まっていない）ではURLを連結しない', async () => {
  // 「https://example.com/single」の後に改行して ASCII 単語が続くケース。
  // 1行目が行末まで埋まっていないため、これは折り返しではなく別の行とみなす。
  const links = uniqueByText(await findLinks('https://example.com/single\r\nnext word'));
  assert.deepEqual(links.map((l) => l.text), ['https://example.com/single']);
});

test('空行・空バッファではクラッシュしない', async () => {
  const links = await findLinks('');
  assert.deepEqual(links, []);
});
