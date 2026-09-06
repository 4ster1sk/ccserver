// ブラウザの「戻る / 進む」履歴操作ガード。
//
// ターミナルへのキー入力中に Backspace / Alt+← 等を誤爆すると、SPA 外へ
// 離脱して入力中の内容や画面状態が失われる。これを防ぐため、同一
// ドキュメント内にダミーの履歴エントリを積み、popstate で捕捉して
// 滞在させる。マウスボタン・スワイプ・戻るボタン等、キー以外の経路も
// popstate 経由で捕捉できるのが history トラップの利点。
//
// モード (localStorage `ccserver-nav-guard`、既定 `confirm`):
// - confirm: 履歴操作を捕捉して window.confirm で離脱確認 (OKで離脱)
// - suppress: 確認なしで黙って抑制 (離脱しない)
// - allow: ガード無効 (従来通りブラウザに任せる)
//
// ショートカットキー (Alt+←/→、macOS の Meta+[/]) は keydown の capture
// フェーズで preventDefault のみ行い、stopPropagation はしない。ブラウザ
// 既定の履歴遷移は止めつつ、xterm 等へのキー配送は維持するため
// (ターミナルの単語移動 Alt+← 等の ESC シーケンスを殺さない)。
// ただし入力欄・ターミナル外にフォーカスがある場合の confirm モードは、
// ブラウザに遷移させて popstate 側で確認ダイアログを出す
// (意図的な「戻る」も確認つきで可能にするため)。
// なお Ctrl+[ は端末の ESC なので決して横取りしない。

import { useEffect, useRef } from 'react';

export const NAV_GUARD_KEY = 'ccserver-nav-guard';
export const NAV_GUARD_MODES = ['confirm', 'suppress', 'allow'];
export const DEFAULT_NAV_GUARD_MODE = 'confirm';

function isNavGuardMode(value) {
  return NAV_GUARD_MODES.includes(value);
}

export function loadNavGuardMode() {
  try {
    const v = localStorage.getItem(NAV_GUARD_KEY);
    if (isNavGuardMode(v)) return v;
  } catch {
    // ignore (private mode etc.)
  }
  return DEFAULT_NAV_GUARD_MODE;
}

export function saveNavGuardMode(mode) {
  // 不正値は保存しない (呼び出し側は select の3択のみだが念のため)。
  if (!isNavGuardMode(mode)) return;
  try {
    localStorage.setItem(NAV_GUARD_KEY, mode);
  } catch {
    // ignore (private mode etc.)
  }
}

const GUARD_STATE = { __ccserverNavGuard: true };

function isGuardState(state) {
  return !!(state && state.__ccserverNavGuard === true);
}

export const NAV_GUARD_LEAVE_MESSAGE =
  'ブラウザの「戻る / 進む」操作が検出されました。このページを離れますか？\n入力中の内容が失われることがあります（セッション自体はサーバー側で動き続けます）。';

// ガードエントリを積んだかどうか (ページ寿命で保持。React StrictMode の
// 二重マウントやモード切替で重複 push しないための抑止)。
let guardEntryPushed = false;
// 現在のガードエントリに対する peel (history.back()) を発行済みか。
// back() は非同期で state が同期的には変わらないため、StrictMode の二重
// effect 等で二重発行すると実履歴まで剥がしてしまう。ガードを push し直
// したら戻す (push 側との非対称を避けるため push 経路は下のヘルパーに集約)。
let guardPeeled = false;

// ガードエントリの push 集約点。実際に積んだ場合のみ guardPeeled を戻す
// (peel 飛行中に state がガードのまま見える二重実行では積まないので戻さない)。
function pushGuardEntry() {
  try {
    if (!isGuardState(window.history.state)) {
      window.history.pushState(GUARD_STATE, '');
      guardPeeled = false;
    }
  } catch {
    // ignore (non-browser env etc.)
  }
}

function ensureGuardEntry() {
  pushGuardEntry();
  guardEntryPushed = true;
}

// 入力系フォーカスか: ここでのキーはアプリのキー操作として扱い、
// ブラウザ遷移は常に黙って抑止する (ターミナル・IME を守る)。
function isEditableTarget(target) {
  if (!target || typeof target.closest !== 'function') return false;
  return !!target.closest(
    'input, textarea, select, [contenteditable="true"], .xterm-helper-textarea'
  );
}

// ブラウザの履歴「戻る / 進む」ショートカットか。
// Alt+←/→ (Win/Linux)、Meta+[/] (macOS Safari/Chrome)。
// Ctrl+[ は端末の ESC として必須のため対象外。
function isNavShortcut(e) {
  if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
    return true;
  }
  if (e.metaKey && !e.ctrlKey && !e.altKey && (e.key === '[' || e.key === ']')) {
    return true;
  }
  return false;
}

export function useNavGuard(mode) {
  const modeRef = useRef(mode);
  modeRef.current = mode;
  // 確認OK後の離脱用 history.back() が popstate を再発火させた場合の
  // 誤認防止フラグ。cross-document 遷移自体は popstate を発火させないが、
  // ガード再 push 済みエントリを剥がす同一ドキュメント遷移があり得るため。
  const leavingRef = useRef(false);
  // 直接オープン時の no-op back() 対策タイマー (下記)。cleanup で解除する。
  const rearmTimerRef = useRef(0);

  useEffect(() => {
    if (mode === 'allow') {
      // confirm / suppress 時に積んだダミーエントリが残っていると、allow 中の
      // 「戻る」1回分がダミーに戻るだけで離脱できなくなるため剥がす。
      // 旧 effect の cleanup 済みで popstate リスナーは無いので確認は出ない。
      try {
        if (!guardPeeled && isGuardState(window.history.state)) {
          guardPeeled = true;
          window.history.back();
        }
      } catch {
        // ignore
      }
      return undefined;
    }
    if (!guardEntryPushed) ensureGuardEntry();
    else pushGuardEntry();

    // allow 切替時の peel back() が飛行中の場合、state はまだガードのまま
    // (back は非同期)。その完了 popstate はユーザーの戻る操作ではないため、
    // 次の 1 回だけ確認なしで消費しガードを積み直す。飛行中の peel は最大
    // 1 発 (2 回目以降の allow は guardPeeled で発行しない) ので単発で足りる。
    // leavingRef との両立はあり得ない: 承認経路はこの消費より後の pop で
    // しか発火せず、その時点で skip は消費済み。peel 経路はフラグを立てない。
    let skipPeelPop = guardPeeled && isGuardState(window.history.state);

    const onPopState = () => {
      if (skipPeelPop) {
        skipPeelPop = false;
        pushGuardEntry();
        return;
      }
      if (leavingRef.current) {
        leavingRef.current = false;
        return;
      }
      const current = modeRef.current;
      if (current === 'allow') return;
      if (current === 'confirm') {
        let leave = false;
        try {
          leave = window.confirm(NAV_GUARD_LEAVE_MESSAGE);
        } catch {
          leave = false;
        }
        if (leave) {
          // 現在はガード直下の同一ドキュメントにいるため、もう一段
          // history.back() して実際に離脱する (cross-document 遷移では
          // popstate は発火しないので、このままページを離れる)。
          leavingRef.current = true;
          try {
            window.history.back();
          } catch {
            leavingRef.current = false;
          }
          // ブックマーク等からの直接オープン ([app, guard] のみ) では
          // 2段目の back() が遷移先なしの no-op になり、popstate /
          // pageshow が発火しないためガード剥がれ・フラグ残留のままに
          // なる。次ティック以降も同一ドキュメントに留まっている場合だけ
          // 再武装する (正常離脱時はアンロード/先行popstateで消費済みの
          // ため何もしない。500ms 以内の低速アンロード中に発火しても、
          // 冪等な積み直しのみで無害)。
          rearmTimerRef.current = window.setTimeout(() => {
            rearmTimerRef.current = 0;
            if (leavingRef.current && modeRef.current !== 'allow') {
              leavingRef.current = false;
              pushGuardEntry();
            }
          }, 500);
          return;
        }
      }
      // suppress / confirmキャンセル: 滞在しガードを積み直す。
      pushGuardEntry();
    };

    const onKeyDown = (e) => {
      const current = modeRef.current;
      if (current === 'allow') return;
      if (!isNavShortcut(e)) return;
      // 入力中・suppress モードは常に黙って抑止 (preventDefault のみで
      // 配送は止めない)。confirm + 非入力フォーカスはブラウザ遷移に任せ、
      // popstate 側で確認ダイアログを出す。
      if (current === 'suppress' || isEditableTarget(e.target)) {
        e.preventDefault();
      }
    };

    // bfcache 復元等では effect が再実行されず、承認離脱で残留した
    // leavingRef とガード剥がれ状態のままになり得るため、ここで再武装する。
    // フルリロード時はモジュール変数が初期化され ensureGuardEntry 側で処理
    // されるので、このハンドラは実質 bfcache 復元用である。初回ロード時の
    // pageshow ではガード積み済みのため何もしない。
    const onPageShow = () => {
      leavingRef.current = false;
      if (modeRef.current !== 'allow') pushGuardEntry();
    };

    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('popstate', onPopState);
    window.addEventListener('pageshow', onPageShow);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('popstate', onPopState);
      window.removeEventListener('pageshow', onPageShow);
      // 保留中の再武装タイマーを消し、残留フラグを戻す。消さないと、
      // confirm-OK 直後のモード切替 (特に allow) でタイマー条件が不成立に
      // なり leavingRef が残留し、次 mode 復帰後の初回 popstate を誤消費
      // してガードを1回素通りさせる。フラグを戻しても再武装は失われない:
      // 切替先が非 allow なら新 effect が即座に積み直す。
      if (rearmTimerRef.current) {
        clearTimeout(rearmTimerRef.current);
        rearmTimerRef.current = 0;
      }
      leavingRef.current = false;
    };
  }, [mode]);
}
