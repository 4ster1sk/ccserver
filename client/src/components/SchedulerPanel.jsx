import { useCallback, useEffect, useRef, useState } from 'react';
import { authFetch } from '../auth.js';

// The scheduled prompt ("予約プロンプト") of one session, shared by
// TerminalView and ChatView. The server owns the schedule; this keeps its
// last pushed state (schedule_state) plus the panel's form.

// Format an absolute epoch as the zero-padded 24h "HH:MM" the scheduler
// panel's <input type="time"> requires, in `timeZone` (server-local if
// omitted). Unlike fmtServer(), this must not go through toLocaleString --
// its output is locale-dependent, while the <input> value format is not.
export function toServerHHMM(epochMs, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timeZone || undefined,
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(new Date(epochMs));
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${map.hour}:${map.minute}`;
}

// send(obj): the session's WS send (a no-op while it is closed).
// open: whether the panel is shown (drives the live clock and the prefill).
export function useScheduledPrompt({ send, app, open }) {
  const [schedule, setSchedule] = useState(null); // { at, text } | null
  const [scheduleTime, setScheduleTime] = useState('');
  const [schedulePromptText, setSchedulePromptText] = useState('');
  const [scheduleError, setScheduleError] = useState('');
  const [serverTz, setServerTz] = useState(null);
  const serverOffsetRef = useRef(0); // serverNow - clientNow (ms)
  const [nowTick, setNowTick] = useState(() => Date.now());

  // Feed every WS message here; returns true for the schedule ones.
  const handleMessage = useCallback((msg) => {
    if (msg.type === 'schedule_state') {
      setSchedule(msg.scheduled || null);
      setScheduleError(msg.error || '');
      if (msg.serverTz) setServerTz(msg.serverTz);
      if (typeof msg.serverNow === 'number') {
        serverOffsetRef.current = msg.serverNow - Date.now();
      }
      return true;
    }
    if (msg.type === 'schedule_fired') {
      setSchedule(null);
      return true;
    }
    return false;
  }, []);

  // Format an absolute epoch in the SERVER's timezone (matching Claude Code's
  // rate-limit reset times), falling back to the browser locale if unknown.
  const fmtServer = useCallback((epoch, opts) => {
    try {
      return new Date(epoch).toLocaleString([], { timeZone: serverTz || undefined, ...opts });
    } catch {
      return new Date(epoch).toLocaleString([], opts);
    }
  }, [serverTz]);

  const submit = useCallback(() => {
    if (!/^(\d{1,2}):(\d{2})$/.test(scheduleTime.trim())) {
      setScheduleError('時刻を HH:MM 形式で入力してください');
      return;
    }
    if (!schedulePromptText.trim()) {
      setScheduleError('プロンプト文面を入力してください');
      return;
    }
    // Send the HH:MM string; the server interprets it in its own timezone.
    if (send({ type: 'schedule_prompt', time: scheduleTime, text: schedulePromptText }) !== false) {
      setScheduleError('');
    }
  }, [send, scheduleTime, schedulePromptText]);

  const cancel = useCallback(() => {
    send({ type: 'cancel_schedule' });
  }, [send]);

  // Tick a live clock while the panel is open so the displayed server time
  // stays current.
  useEffect(() => {
    if (!open) return;
    const t = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(t);
  }, [open]);

  // On opening a fresh (no active schedule, untouched time field) panel,
  // prefill the time with the last-known session-limit reset time -- a
  // passive lookup, it never triggers a new /usage capture. Only "claude"
  // sessions have a session limit to speak of. Requiring serverTz first
  // (rather than falling back to the browser's zone) avoids a wrong initial
  // value on a server in a different timezone; schedule_state normally
  // delivers it well before a user could open this panel.
  useEffect(() => {
    if (!open || schedule || scheduleTime || !serverTz || app !== 'claude') return;
    let cancelled = false;
    authFetch('/api/session-limit-reset')
      .then((res) => res.json())
      .then((data) => {
        if (cancelled || !data?.resetAtMs) return;
        setScheduleTime((prev) => (prev ? prev : toServerHHMM(data.resetAtMs, data.timeZone || serverTz)));
      })
      .catch(() => { /* best effort */ });
    return () => { cancelled = true; };
  }, [open, schedule, scheduleTime, serverTz, app]);

  return {
    schedule, scheduleTime, setScheduleTime, schedulePromptText, setSchedulePromptText,
    scheduleError, serverTz, serverNow: nowTick + serverOffsetRef.current,
    handleMessage, fmtServer, submit, cancel,
  };
}

export default function SchedulerPanel({ sched, onClose }) {
  const { schedule, scheduleTime, setScheduleTime, schedulePromptText, setSchedulePromptText, scheduleError, serverTz, serverNow, fmtServer, submit, cancel } = sched;
  return (
    <div className="scheduler-panel">
      <div className="scheduler-header">
        <span>予約プロンプト</span>
        <button className="btn btn-secondary btn-sm" onClick={onClose}>&#10005;</button>
      </div>
      <div className="scheduler-servertime">
        サーバー現在時刻: {fmtServer(serverNow)}
        {serverTz ? ` (${serverTz})` : ' (タイムゾーン取得中…)'}
      </div>
      {schedule ? (
        <div className="scheduler-active">
          <div className="scheduler-active-info">
            <span className="scheduler-active-time">
              {fmtServer(schedule.at)} に送信予定
            </span>
            <span className="scheduler-active-text">{schedule.text}</span>
          </div>
          <button className="btn btn-secondary btn-sm" onClick={cancel}>キャンセル</button>
        </div>
      ) : (
        <div className="scheduler-form">
          <div className="scheduler-form-row">
            <input
              type="time"
              className="key-config-input scheduler-time"
              value={scheduleTime}
              onChange={(e) => setScheduleTime(e.target.value)}
            />
            <span className="scheduler-hint">サーバー時刻で送信(過ぎていれば翌日)</span>
          </div>
          <textarea
            className="terminal-input scheduler-text"
            value={schedulePromptText}
            onChange={(e) => setSchedulePromptText(e.target.value)}
            placeholder="送信するプロンプト文面..."
            rows={2}
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
          />
          <div className="scheduler-form-actions">
            <button
              className="btn btn-primary btn-sm"
              onClick={submit}
              disabled={!scheduleTime || !schedulePromptText.trim()}
            >
              予約する
            </button>
          </div>
        </div>
      )}
      {scheduleError && <div className="scheduler-error">{scheduleError}</div>}
    </div>
  );
}
