// Shared tab-icon rendering for terminal tabs.
const shellIcon = <svg className="tab-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M3.5 5l4 3-4 3"/><path d="M8.5 12h4"/></svg>;
const opencodeIcon = <svg className="tab-icon" viewBox="0 0 16 16" fill="currentColor"><path fillRule="evenodd" d="M4 3h8v10H4V3zm7 1H5v8h6V4z"/><path opacity="0.45" d="M6 7h4v4H6V7z"/></svg>;
const claudeIcon = <svg className="tab-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"><path d="M8 2v12M3.2 5l9.6 6M12.8 5l-9.6 6"/></svg>;
// opencode in chat mode (ui 'chat'): a speech bubble next to the app icon.
const chatIcon = <svg className="tab-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"><path d="M2.5 4A1.5 1.5 0 014 2.5h8A1.5 1.5 0 0113.5 4v5A1.5 1.5 0 0112 10.5H7l-3 2.5v-2.5A1.5 1.5 0 012.5 9z"/></svg>;
const codexIcon = <svg className="tab-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"><path d="M3 4.5 8 2l5 2.5v7L8 14l-5-2.5z"/><path d="m3 4.5 5 2.7 5-2.7M8 7.2V14"/></svg>;

// Session hamburger menu (SessionTabMenu.jsx / App.jsx's sidebar-mode toggle):
// a terminal-prompt glyph ([>_]-ish), same "rect frame + chevron" family as
// shellIcon above, so the two open/close buttons that share
// one job (toggle the session list) also share one icon instead of each
// hardcoding its own "☰" string.
export const sessionMenuIcon = <svg className="tab-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><path d="M4 6.3l2.4 1.7-2.4 1.7"/><path d="M9 9.7h2.5"/></svg>;

export default function TabIcon({ type, app, shell, ui }) {
  if (type === 'browser') {
    return <svg className="tab-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M2 3.5A1.5 1.5 0 013.5 2h3l1.5 2h4.5A1.5 1.5 0 0114 5.5v7a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 012 12.5z"/></svg>;
  }
  if (type === 'settings') {
    return <svg className="tab-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>;
  }

  if (type === 'terminal') {
    const icons = [];
    if (shell) icons.push(shellIcon);
    if (app === 'opencode') icons.push(ui === 'chat' ? chatIcon : opencodeIcon);
    if (app === 'codex') icons.push(codexIcon);
    if (app === 'claude' && !shell) icons.push(claudeIcon);
    return <>{icons}</>;
  }
  return null;
}
