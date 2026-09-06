// "一般" メニューのプレースホルダ。将来的にテーマ切替・通知トグル・
// 終了確認設定など、現在 TerminalView / App に分散している表示系設定の
// 移設先として確保する。現時点では振る舞いを持たない。
export default function GeneralPlaceholderSection() {
  return (
    <section className="settings-section">
      <h3>一般</h3>
      <p className="settings-empty">
        一般設定は準備中です。今後テーマ・通知などの表示設定をここにまとめます。
      </p>
    </section>
  );
}
