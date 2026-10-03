const ANSI_RE = /\x1b(?:\[[0-9;?]*[a-zA-Z]|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[()][A-Z0-9]|[>=<]|#[0-9])/g;

export function stripAnsi(text) {
  return text.replace(ANSI_RE, '');
}
