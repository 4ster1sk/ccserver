import { startAuthentication } from '@simplewebauthn/browser';
import { authFetch } from './auth.js';
import { getPrfAssertion } from './passkeyPrf.js';

// Passkey step-up ceremonies, React-independent (just authFetch + WebAuthn),
// shared by the settings screens, the top bar and the approval banner.

export async function readJsonError(res) {
  try {
    const body = await res.json();
    return body.error || `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

export async function postJson(url, body) {
  const res = await authFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  if (!res.ok) {
    throw new Error(await readJsonError(res));
  }
  return res.json();
}

// <kind>-options を取得 -> PRF儀式 -> <kind>-verify の3ステップ。verifyExtra は
// verify の body に足すフィールド (パスキー登録時のパスフレーズなど)。
export async function runPrfCeremony({ optionsUrl, verifyUrl, verifyExtra = {} }) {
  const optionsRes = await authFetch(optionsUrl, { method: 'POST' });
  if (!optionsRes.ok) {
    throw new Error(await readJsonError(optionsRes));
  }
  const response = await getPrfAssertion(await optionsRes.json());
  return postJson(verifyUrl, { response, ...verifyExtra });
}

// セッションのステップアップ (セキュリティ監査 F2): 登録済みパスキーでの
// ユーザー検証付き認証を行い、このセッションに「5分以内に再認証済み」を
// 記録する。新しいパスキーの登録や、コミット署名鍵の削除の前提条件。
export async function runPasskeyStepUp() {
  const optionsRes = await authFetch('/api/auth/webauthn/stepup-options', { method: 'POST' });
  if (!optionsRes.ok) {
    throw new Error(await readJsonError(optionsRes));
  }
  const optionsJSON = await optionsRes.json();
  const response = await startAuthentication({ optionsJSON });
  return postJson('/api/auth/webauthn/stepup-verify', { response });
}
