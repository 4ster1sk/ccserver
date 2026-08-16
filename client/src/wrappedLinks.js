// URLを実改行で折り返した場合のリンク復元。
//
// opencode (や同種のTUI) は `wrapMode: "word"` で独自に折り返しを行うため、
// 幅に収まらない長いURLを「実改行」で次の行へ送る。xtermのバッファでは続き行は
// isWrapped=false（ターミナルのソフトラップではない）となり、
// @xterm/addon-web-links の WebLinkProvider は isWrapped=true の行しか連結しない。
// その結果、先頭行に残ったURLの断片だけがリンクになり、クリックすると正しいURLが
// 開かない。
//
// このプロバイダは isWrapped に関係なく、折り返しで分断されたURL断片を行をまたいで
// 連結し、複数行にまたがるリンクを返す。単一行・ソフトラップのURLも従来どおり処理する。
//
// 折り返しの判定（偽陽性を避けるためのガード）:
//   - 直前の行が「行の端まで埋まっている」（セル数 >= cols-2）＝折り返しで打ち切られた
//   - 直前の行の末尾がURLを構成する文字
//   - 次の行の先頭（インデントを除く）がURLを構成する文字
// 一方「意図的な改行」は行が埋まらず短いか、続く行が空白/句読点/ブロック記号で始まる。
const URL_START_SRC = '(https?|HTTPS?):[/]{2}[^\\s"\'!*(){}|\\\\\\^<>`]*[^\\s"\':,.!?{}|\\\\\\^~\\[\\]`()<>]';
const URL_BODY_CHARS = "A-Za-z0-9\\-._~:/?#\\[\\]@!$&'()*+,;=%";
const URL_BODY_RE = new RegExp(`^[${URL_BODY_CHARS}]`);
const URL_RUN_RE = new RegExp(`^[${URL_BODY_CHARS}]+`);
// 行頭の折り返しインデント（opencodeのメッセージ領域の余白や2文字インデント）
const LEAD_INDENT_RE = /^[ \t]+/;
// URLの末尾に付き得る終了禁則文字（addonの strictUrlRegex の最終文字クラスと同系）
const TRAILING_RE = /[\s"'`:,.!?{}|\\^~\[\]`()<>]+$/;

function isUrl(urlString) {
  try {
    const url = new URL(urlString);
    const parsedBase = url.password && url.username
      ? `${url.protocol}//${url.username}:${url.password}@${url.host}`
      : url.username
        ? `${url.protocol}//${url.username}@${url.host}`
        : `${url.protocol}//${url.host}`;
    return urlString.toLowerCase().startsWith(parsedBase.toLowerCase());
  } catch {
    return false;
  }
}

// 行が「内容領域いっぱいまで埋まっている」（= 折り返しで打ち切られた）かどうか。
// opencode はメッセージを端末幅いっぱいではなく、左マージン/右パディング付きの
// 内容領域に絶対カーソル位置指定で描画するため、折り返し行のセル数は cols より
// 少なくなる。cols-2 のような厳しい判定では連結できず、端末幅の半分以上の行を
// 「埋まっている」とみなす（意図的な改行で短い行が終わるケースは除外される）。
function isFullRow(cells, cols) {
  return cells >= Math.max(16, cols * 0.5);
}

// バッファ1行分の表示文字列と、各文字列インデックス -> バッファ列、および総セル数を返す。
function buildRow(line) {
  const cellOf = [];
  let text = '';
  let cells = 0;
  for (let x = 0; x < line.length; x++) {
    const cell = line.getCell(x);
    const chars = cell.getChars();
    if (!chars) continue;
    cells += Math.max(1, cell.getWidth());
    for (let i = 0; i < chars.length; i++) cellOf[text.length + i] = x;
    text += chars;
  }
  return { text, cellOf, cells };
}

function buildRowAt(buf, idx) {
  const line = buf.getLine(idx);
  return line ? buildRow(line) : null;
}

// 直前の行が折り返しで打ち切られたURLの続きか（= 次の行がURLの続き行か）。
function isContinuation(prev, cur, cols) {
  if (!prev.text || !cur.text) return false;
  if (!isFullRow(prev.cells, cols)) return false;
  if (!URL_BODY_RE.test(prev.text[prev.text.length - 1])) return false;
  const first = cur.text.replace(LEAD_INDENT_RE, '')[0];
  return Boolean(first && URL_BODY_RE.test(first));
}

// startRow の frag を起点に、続きの行へURL断片を連結する。
// 返り値: { url, endRow, endIdx }（endIdx は endRow 上のURL末尾の次の文字列インデックス）
function reconstructUrl(buf, cols, startRow, frag) {
  const start = buildRowAt(buf, startRow);
  let url = start.text.slice(frag.start, frag.end);
  let endRow = startRow;
  let endIdx = frag.end;

  // 断片が行末まで詰まって初めて「折り返し」の可能性がある。
  if (frag.end === start.text.length && isFullRow(start.cells, cols)) {
    let curRow = startRow;
    while (true) {
      const next = buildRowAt(buf, curRow + 1);
      if (!next) break;
      const stripped = next.text.replace(LEAD_INDENT_RE, '');
      if (!stripped) break;
      const run = stripped.match(URL_RUN_RE);
      if (!run) break;
      const lead = next.text.length - stripped.length;
      url += run[0];
      endRow = curRow + 1;
      endIdx = lead + run[0].length;
      // この行の表示途中（空白/記号が続いた）でURLが終わったならここで終了。
      // 行末まで続いたなら、さらに次の行へ連結を試みる。
      if (run[0].length < stripped.length) break;
      curRow += 1;
    }
  }

  return { url, endRow, endIdx };
}

// URL末尾の終了禁則文字を除去し、endRow/endIdx を追従させる。
function trimTrailingPunct(buf, url, endRow, endIdx) {
  const m = url.match(TRAILING_RE);
  if (!m) return { url, endRow, endIdx };
  let drop = m[0].length;
  let u = url.slice(0, url.length - drop);
  let row = endRow;
  let idx = endIdx;
  while (drop > 0) {
    while (idx > 0 && drop > 0) {
      idx -= 1;
      drop -= 1;
    }
    if (drop > 0) {
      row -= 1;
      if (row < 0) break;
      idx = buildRowAt(buf, row).text.length;
    }
  }
  return { url: u, endRow: row, endIdx: idx };
}

// 行 lineIdx が「上の行から続いたURLの折り返し続き行」なら、そのURLの起点行を返す。
function findUpstreamStart(buf, cols, lineIdx) {
  let startRow = lineIdx;
  while (startRow > 0) {
    const prev = buildRowAt(buf, startRow - 1);
    const cur = buildRowAt(buf, startRow);
    if (!prev || !cur || !isContinuation(prev, cur, cols)) break;
    startRow -= 1;
  }
  if (startRow === lineIdx) return null;
  const row = buildRowAt(buf, startRow);
  const rex = new RegExp(URL_START_SRC, 'g');
  let m;
  while ((m = rex.exec(row.text))) {
    if (m.index + m[0].length === row.text.length) {
      return { startRow, frag: { start: m.index, end: m.index + m[0].length } };
    }
  }
  return null;
}

function makeLink(terminal, url, startRow, startIdx, endRow, endIdx) {
  if (!isUrl(url)) return null;
  const buf = terminal.buffer.active;
  const startCell = buildRowAt(buf, startRow).cellOf[startIdx];
  const endRowObj = buildRowAt(buf, endRow);
  const lastIdx = endIdx - 1;
  if (lastIdx < 0 || startCell === undefined || endRowObj.cellOf[lastIdx] === undefined) return null;
  const lastCol = endRowObj.cellOf[lastIdx];
  return {
    range: {
      start: { x: startCell + 1, y: startRow + 1 },
      end: { x: lastCol, y: endRow + 1 },
    },
    text: url,
    activate: (event) => openLink(event, url),
  };
}

// addon の handleLink と同じ: 新しいウィンドウで開き、opener を剥がす。
function openLink(event, uri) {
  const newWindow = window.open();
  if (newWindow) {
    try {
      newWindow.opener = null;
    } catch {
      // Electron などで例外になり得る
    }
    newWindow.location.href = uri;
  } else {
    console.warn('Opening link blocked as opener could not be cleared');
  }
}

// 実改行で折り返されたURLも含めて、行をまたぐURLを検出する LinkProvider。
export class WrappedLinkProvider {
  constructor(terminal) {
    this._terminal = terminal;
  }

  provideLinks(y, callback) {
    const buf = this._terminal.buffer.active;
    const cols = this._terminal.cols;
    const lineIdx = y - 1;
    if (!buf.getLine(lineIdx)) {
      callback(undefined);
      return;
    }

    const links = [];

    // この行が上の行から折り返して続いたURLの続き行なら、起点から全体を復元する。
    const upstream = findUpstreamStart(buf, cols, lineIdx);
    if (upstream) {
      const full = reconstructUrl(buf, cols, upstream.startRow, upstream.frag);
      const trimmed = trimTrailingPunct(buf, full.url, full.endRow, full.endIdx);
      const link = makeLink(this._terminal, trimmed.url, upstream.startRow, upstream.frag.start, trimmed.endRow, trimmed.endIdx);
      if (link) links.push(link);
    }

    // この行自身から始まるURL。
    const row = buildRowAt(buf, lineIdx);
    if (row && row.text) {
      const rex = new RegExp(URL_START_SRC, 'g');
      let m;
      while ((m = rex.exec(row.text))) {
        const frag = { start: m.index, end: m.index + m[0].length };
        const full = reconstructUrl(buf, cols, lineIdx, frag);
        const trimmed = trimTrailingPunct(buf, full.url, full.endRow, full.endIdx);
        const link = makeLink(this._terminal, trimmed.url, lineIdx, frag.start, trimmed.endRow, trimmed.endIdx);
        if (link) links.push(link);
      }
    }

    const seen = new Set();
    const uniq = links.filter((l) => {
      const key = `${l.range.start.y}:${l.range.start.x}-${l.range.end.y}:${l.range.end.x}:${l.text}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    callback(uniq.length ? uniq : undefined);
  }
}
