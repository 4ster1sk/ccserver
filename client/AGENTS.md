# client/ — エージェント向けガイド

- `src/App.jsx`: タブ、グローバルな Provider (署名鍵の状態など)、上部バー、承認バナー
- `src/components/`: 画面部品。設定画面は `SettingsView.jsx` の左メニューから各 `*Section.jsx` を開く
- `src/components/chat/`: チャット表示 (opencode / Claude Code)
- `src/hooks/`: ポーリングは `useVisiblePolling` (タブが見えている間だけ動く)
- 通信は `src/auth.js` の `authFetch` を使う (認証モードの違いを吸収する)
- スタイルは `src/styles/app.css` の 1 ファイル。色は CSS 変数 (`--bg-primary` など)、テーマは `src/themes.js`
- 起動オプションの記憶: 全体の既定値は `src/sandboxDefaults.js`、ディレクトリ別は `src/components/DirectoryBrowser.jsx`
- UI の文言は日本語。サーバーの API は `docs-site/src/content/docs/reference/api.md` を参照
- 変更後は `npx vite build --outDir <一時ディレクトリ>` でビルドが通ることを確認する
