import { useCallback, useEffect, useRef, useState } from 'react';
import { ocRequest, subscribeChatEvents } from './chatApi.js';
import { applyMessageEvent, lastAssistantRunning, sortMessages, upsertMessage } from './chatReducer.js';

const HISTORY_LIMIT = 200;

// The conversation of one opencode session: history from the REST API,
// then live updates from the event stream (applied by chatReducer). The
// list is re-read from the server whenever it can safely be -- on every
// (re)connect of the stream and when a turn ends -- so anything the live
// reducer does not model (system notes, compaction, shell output) still
// appears.
export function useOpencodeChat({ sessionId, ocSessionId, enabled }) {
  const [messages, setMessages] = useState([]);
  const [pending, setPending] = useState([]); // optimistic user prompts: { localId, inboxId, text, time, failed }
  const [busy, setBusy] = useState(false);
  const [permissions, setPermissions] = useState([]);
  const [forms, setForms] = useState([]);
  const [info, setInfo] = useState(null); // Session.Info
  const [models, setModels] = useState([]);
  const [agents, setAgents] = useState([]);
  const [commands, setCommands] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [streamConnected, setStreamConnected] = useState(false);
  const [error, setError] = useState(null);
  const busyRef = useRef(false);
  busyRef.current = busy;

  const sid = sessionId;
  const ses = ocSessionId ? encodeURIComponent(ocSessionId) : null;

  const reload = useCallback(async () => {
    if (!sid || !ses) return;
    try {
      const [list, perms, fms, sessionInfo] = await Promise.all([
        ocRequest(sid, 'GET', `session/${ses}/message?order=desc&limit=${HISTORY_LIMIT}`),
        ocRequest(sid, 'GET', `session/${ses}/permission`).catch(() => null),
        ocRequest(sid, 'GET', `session/${ses}/form`).catch(() => null),
        ocRequest(sid, 'GET', `session/${ses}`).catch(() => null),
      ]);
      const msgs = sortMessages(Array.isArray(list?.data) ? list.data : []);
      setMessages(msgs);
      setPending((prev) => prev.filter((p) => !p.inboxId || !msgs.some((m) => m.id === p.inboxId)));
      if (perms?.data) setPermissions(perms.data);
      if (fms?.data) setForms(fms.data);
      if (sessionInfo?.data) setInfo(sessionInfo.data);
      setBusy(lastAssistantRunning(msgs));
      setLoaded(true);
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  }, [sid, ses]);

  // Catalogs for the composer (model / agent pickers, slash commands).
  useEffect(() => {
    if (!enabled || !sid) return;
    let cancelled = false;
    Promise.all([
      ocRequest(sid, 'GET', 'model').catch(() => null),
      ocRequest(sid, 'GET', 'agent').catch(() => null),
      ocRequest(sid, 'GET', 'command').catch(() => null),
    ]).then(([m, a, c]) => {
      if (cancelled) return;
      if (Array.isArray(m?.data)) setModels(m.data);
      if (Array.isArray(a?.data)) setAgents(a.data.filter((x) => !x.hidden && x.mode !== 'subagent'));
      if (Array.isArray(c?.data)) setCommands(c.data);
    });
    return () => { cancelled = true; };
  }, [enabled, sid]);

  useEffect(() => {
    if (!enabled || !sid || !ses) return undefined;
    const ac = new AbortController();
    const mine = (d) => d && (d.sessionID === ocSessionId || d.form?.sessionID === ocSessionId);
    subscribeChatEvents(sid, {
      signal: ac.signal,
      onOpen: () => { setStreamConnected(true); reload(); },
      onDisconnect: () => setStreamConnected(false),
      onEvent: (event) => {
        const d = event.data;
        if (!mine(d)) return;
        switch (event.type) {
          case 'session.execution.started':
            setBusy(true);
            return;
          case 'session.execution.succeeded':
          case 'session.execution.failed':
          case 'session.execution.interrupted':
            setBusy(false);
            reload();
            return;
          case 'session.inbox.delivered':
            ocRequest(sid, 'GET', `session/${ses}/message/${encodeURIComponent(d.inboxID)}`)
              .then((res) => {
                if (!res?.data) return;
                setMessages((prev) => upsertMessage(prev, res.data));
                setPending((prev) => prev.filter((p) => p.inboxId !== d.inboxID));
              })
              .catch(() => {});
            return;
          case 'session.inbox.cancelled':
            setPending((prev) => prev.filter((p) => p.inboxId !== d.inboxID));
            return;
          case 'session.renamed':
            setInfo((prev) => (prev ? { ...prev, title: d.title } : prev));
            return;
          case 'session.model.selected':
            setInfo((prev) => (prev ? { ...prev, model: d.model } : prev));
            return;
          case 'session.agent.selected':
            setInfo((prev) => (prev ? { ...prev, agent: d.agent } : prev));
            return;
          case 'permission.asked':
            setPermissions((prev) => (prev.some((p) => p.id === d.id) ? prev : [...prev, d]));
            return;
          case 'permission.replied':
            setPermissions((prev) => prev.filter((p) => p.id !== d.requestID));
            return;
          case 'form.created':
            setForms((prev) => (prev.some((f) => f.id === d.form.id) ? prev : [...prev, d.form]));
            return;
          case 'form.replied':
          case 'form.cancelled':
            setForms((prev) => prev.filter((f) => f.id !== d.id));
            return;
          default:
            if (event.type === 'session.step.started') setBusy(true);
            setMessages((prev) => applyMessageEvent(prev, event));
        }
      },
    });
    return () => ac.abort();
  }, [enabled, sid, ses, ocSessionId, reload]);

  const send = useCallback(async (text) => {
    if (!sid || !ses || !text.trim()) return;
    const localId = `local-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setPending((prev) => [...prev, { localId, inboxId: null, text, time: { created: Date.now() } }]);
    try {
      // Sent while a turn runs: queue it behind the turn, like typing into
      // a busy TUI, rather than steering the running one.
      const res = await ocRequest(sid, 'POST', `session/${ses}/prompt`, { text, ...(busyRef.current ? { delivery: 'queue' } : {}) });
      const inboxId = res?.data?.id || null;
      setPending((prev) => prev.map((p) => (p.localId === localId ? { ...p, inboxId } : p)));
    } catch (err) {
      setPending((prev) => prev.map((p) => (p.localId === localId ? { ...p, failed: err.message } : p)));
    }
  }, [sid, ses]);

  const runCommand = useCallback(async (name, text) => {
    if (!sid || !ses) return;
    await ocRequest(sid, 'POST', `session/${ses}/command`, { name, text: text || '' });
  }, [sid, ses]);

  const interrupt = useCallback(async () => {
    if (!sid || !ses) return;
    await ocRequest(sid, 'POST', `session/${ses}/interrupt`).catch((err) => setError(err.message));
  }, [sid, ses]);

  const replyPermission = useCallback(async (requestId, decision) => {
    await ocRequest(sid, 'POST', `session/${ses}/permission/${encodeURIComponent(requestId)}/reply`, { decision });
    setPermissions((prev) => prev.filter((p) => p.id !== requestId));
  }, [sid, ses]);

  const replyForm = useCallback(async (formId, answer) => {
    await ocRequest(sid, 'POST', `session/${ses}/form/${encodeURIComponent(formId)}/reply`, { answer });
    setForms((prev) => prev.filter((f) => f.id !== formId));
  }, [sid, ses]);

  const cancelForm = useCallback(async (formId) => {
    await ocRequest(sid, 'DELETE', `session/${ses}/form/${encodeURIComponent(formId)}`);
    setForms((prev) => prev.filter((f) => f.id !== formId));
  }, [sid, ses]);

  const switchModel = useCallback(async (model) => {
    await ocRequest(sid, 'POST', `session/${ses}/model`, { model });
    setInfo((prev) => (prev ? { ...prev, model } : prev));
  }, [sid, ses]);

  const switchAgent = useCallback(async (agent) => {
    await ocRequest(sid, 'POST', `session/${ses}/agent`, { agent });
    setInfo((prev) => (prev ? { ...prev, agent } : prev));
  }, [sid, ses]);

  const dismissPending = useCallback((localId) => {
    setPending((prev) => prev.filter((p) => p.localId !== localId));
  }, []);

  return {
    messages, pending, busy, permissions, forms, info, models, agents, commands, loaded, streamConnected, error,
    send, runCommand, interrupt, replyPermission, replyForm, cancelForm, switchModel, switchAgent, dismissPending, reload,
  };
}
