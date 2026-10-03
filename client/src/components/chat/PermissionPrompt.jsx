import { useState } from 'react';

// A pending permission request (Permission.Request): what the agent wants
// to do, answered once / always / reject.
export function PermissionPrompt({ request, onReply }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const reply = async (decision) => {
    setBusy(true);
    setError(null);
    try {
      await onReply(request.id, decision);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };
  const resources = Array.isArray(request.resources) ? request.resources : [];
  return (
    <div className="chat-prompt-card permission" role="alertdialog" aria-label="許可が必要です">
      <div className="chat-prompt-title">⚠ 許可が必要です</div>
      {request.message && <div className="chat-prompt-text">{request.message}</div>}
      <div className="chat-prompt-detail">
        <span className="chat-prompt-action">{request.action}</span>
        {resources.map((r) => <code key={r} className="chat-prompt-resource">{r}</code>)}
      </div>
      {Array.isArray(request.save) && request.save.length > 0 && (
        <div className="chat-prompt-hint">「常に許可」で {request.save.join(', ')} を以後許可します</div>
      )}
      {error && <div className="chat-msg-error">{error}</div>}
      <div className="chat-prompt-actions">
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => reply('once')}>今回のみ許可</button>
        <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => reply('always')}>常に許可</button>
        <button type="button" className="btn btn-secondary chat-reject" disabled={busy} onClick={() => reply('reject')}>拒否</button>
      </div>
    </div>
  );
}

function initialValue(field) {
  if (field.default !== undefined) return field.default;
  if (field.type === 'boolean') return false;
  if (field.type === 'multiselect') return [];
  return '';
}

function visible(field, values) {
  if (field.hidden) return false;
  if (!Array.isArray(field.when) || field.when.length === 0) return true;
  // Form.When: { key, op: 'eq' | 'neq', value } -- all must hold.
  return field.when.every((w) => (w.op === 'neq' ? values[w.key] !== w.value : values[w.key] === w.value));
}

// A question form from the agent (Form.Info): one control per field.
export function FormPrompt({ form, onSubmit, onCancel }) {
  const [values, setValues] = useState(() => Object.fromEntries(form.fields.map((f) => [f.key, initialValue(f)])));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (key, v) => setValues((prev) => ({ ...prev, [key]: v }));

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const answer = {};
    for (const f of form.fields) {
      if (!visible(f, values) || f.type === 'external') continue;
      let v = values[f.key];
      if (f.type === 'number' || f.type === 'integer') {
        if (v === '' || v === undefined) continue;
        v = Number(v);
      }
      if (v === '' && !f.required) continue;
      answer[f.key] = v;
    }
    try {
      await onSubmit(form.id, answer);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <form className="chat-prompt-card form" onSubmit={submit}>
      <div className="chat-prompt-title">❓ {form.title}</div>
      {form.fields.filter((f) => visible(f, values)).map((f) => (
        <label key={f.key} className="chat-form-field">
          <span className="chat-form-label">{f.title || f.key}{f.required ? ' *' : ''}</span>
          {f.description && <span className="chat-form-desc">{f.description}</span>}
          {f.type === 'boolean' && (
            <input type="checkbox" checked={!!values[f.key]} onChange={(e) => set(f.key, e.target.checked)} />
          )}
          {f.type === 'multiselect' && (
            <span className="chat-form-options">
              {(f.options || []).map((o) => (
                <label key={o.value} className="chat-form-option">
                  <input
                    type="checkbox"
                    checked={(values[f.key] || []).includes(o.value)}
                    onChange={(e) => set(f.key, e.target.checked
                      ? [...(values[f.key] || []), o.value]
                      : (values[f.key] || []).filter((x) => x !== o.value))}
                  />
                  {o.label}
                </label>
              ))}
            </span>
          )}
          {f.type === 'string' && Array.isArray(f.options) && f.options.length > 0 && !f.custom && (
            <select value={values[f.key]} onChange={(e) => set(f.key, e.target.value)} required={!!f.required}>
              <option value="">選択してください</option>
              {f.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          )}
          {f.type === 'string' && (!Array.isArray(f.options) || f.options.length === 0 || f.custom) && (
            <input
              type="text"
              value={values[f.key]}
              placeholder={f.placeholder || ''}
              list={f.options?.length ? `opts-${form.id}-${f.key}` : undefined}
              onChange={(e) => set(f.key, e.target.value)}
              required={!!f.required}
            />
          )}
          {f.type === 'string' && f.custom && f.options?.length > 0 && (
            <datalist id={`opts-${form.id}-${f.key}`}>
              {f.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </datalist>
          )}
          {(f.type === 'number' || f.type === 'integer') && (
            <input type="number" step={f.type === 'integer' ? 1 : 'any'} value={values[f.key]} onChange={(e) => set(f.key, e.target.value)} required={!!f.required} />
          )}
          {f.type === 'external' && (
            <a className="chat-form-desc" href={f.url} target="_blank" rel="noopener noreferrer">{f.url}</a>
          )}
        </label>
      ))}
      {error && <div className="chat-msg-error">{error}</div>}
      <div className="chat-prompt-actions">
        <button type="submit" className="btn btn-primary" disabled={busy}>回答する</button>
        <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => onCancel(form.id)}>スキップ</button>
      </div>
    </form>
  );
}
