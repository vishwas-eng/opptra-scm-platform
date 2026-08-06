import { AnimatePresence, motion } from 'framer-motion';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Badge, Button, EmptyState, PageTransition, Textarea } from '../components/ui.jsx';
import { api, streamPost } from '../lib/api.js';
import { useToast } from '../lib/toast.jsx';
import ToolCall from './agent/ToolCall.jsx';
import ScheduleBar from './agent/ScheduleBar.jsx';
import Playbooks from './agent/Playbooks.jsx';
import './agent.css';

const SUGGESTIONS = [
  'Check the Unicommerce session health',
  'Show me sale order SO02696',
  'List the spreadsheets I have bound',
  'Which shipments are stuck in packed today?',
];

export default function Agent() {
  const { ok, bad } = useToast();
  const [meta, setMeta] = useState(null);
  const [connectors, setConnectors] = useState([]);
  const [threads, setThreads] = useState([]);
  const [threadId, setThreadId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [live, setLive] = useState(null); // the turn currently streaming
  const [showSchedule, setShowSchedule] = useState(false);
  const [playbookNonce, setPlaybookNonce] = useState(0);
  const scrollRef = useRef(null);
  const inputRef = useRef(null);

  const loadThreads = useCallback(async () => {
    const r = await api('/api/agent/threads').catch(() => ({ threads: [] }));
    setThreads(r.threads || []);
  }, []);

  const loadMessages = useCallback(async (uid) => {
    if (!uid) { setMessages([]); return; }
    const r = await api(`/api/agent/threads/${encodeURIComponent(uid)}/messages`).catch(() => null);
    setMessages(r?.messages || []);
  }, []);

  useEffect(() => {
    api('/api/agent/meta').then(setMeta).catch(() => {});
    api('/api/agent/connectors').then((r) => setConnectors(r.connectors || [])).catch(() => {});
    loadThreads();
  }, [loadThreads]);

  useEffect(() => { loadMessages(threadId); }, [threadId, loadMessages]);

  // Follow the conversation as it grows, including while a turn streams in.
  useEffect(() => {
    const box = scrollRef.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [messages, live]);

  const connected = connectors.filter((c) => c.live && c.connected);

  const send = useCallback(async (text) => {
    const message = String(text ?? draft).trim();
    if (!message || busy) return;
    setDraft('');
    setBusy(true);
    setMessages((m) => [...m, { id: `local-${Date.now()}`, role: 'user', content: message }]);
    setLive({ phase: 'thinking', tools: [], content: '' });

    try {
      await streamPost('/api/agent/chat/stream', { message, threadId: threadId || undefined }, {
        onEvent: (name, data) => {
          if (name === 'start') {
            setThreadId(data.threadId);
          } else if (name === 'phase') {
            setLive((l) => ({ ...l, phase: 'thinking' }));
          } else if (name === 'tool_start') {
            setLive((l) => ({
              ...l,
              phase: 'tool',
              tools: [...l.tools, { id: data.id, name: data.name, args: data.args, status: 'running' }],
            }));
          } else if (name === 'tool_end') {
            setLive((l) => ({
              ...l,
              tools: l.tools.map((t) => (t.id === data.id
                ? { ...t, status: data.status, result: data.result, error: data.error }
                : t)),
            }));
          } else if (name === 'message') {
            setLive((l) => ({ ...l, phase: 'answering', content: data.content }));
          } else if (name === 'error') {
            bad(data.error || 'The agent hit an error.');
          } else if (name === 'done') {
            setThreadId(data.threadId);
          }
        },
      });
      // The server has already persisted the turn; re-reading it is what guarantees the
      // on-screen thread matches what a reload would show.
      await loadThreads();
      await loadMessages(threadId || undefined);
    } catch (err) {
      bad(err.message || 'Could not reach the agent.');
    } finally {
      setBusy(false);
      setLive(null);
      inputRef.current?.focus();
    }
  }, [draft, busy, threadId, loadThreads, loadMessages, bad]);

  // The streamed turn is thrown away once the server copy lands; until then it IS the
  // conversation, so refresh from the server keyed on the thread we just learned.
  useEffect(() => {
    if (!busy && threadId) loadMessages(threadId);
  }, [busy, threadId, loadMessages]);

  const newChat = () => {
    setThreadId(null);
    setMessages([]);
    inputRef.current?.focus();
  };

  const onKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  const visible = messages.filter((m) => m.role === 'user' || m.role === 'assistant');

  return (
    <PageTransition>
      <div className="agent-shell">
        <header className="agent-head">
          <div className="agent-head-title">
            <h3>Agent</h3>
            <Badge tone="brand">Beta</Badge>
            {meta && <span className="meta">{meta.llmMode === 'tool-router' ? 'Rule mode' : meta.llmMode}</span>}
          </div>
          <div className="agent-head-actions">
            <Button variant="ghost" onClick={() => setShowSchedule((s) => !s)} disabled={!threadId}>
              Automate daily
            </Button>
            <Button variant="ghost" onClick={newChat}>New chat</Button>
            <Link className="btn btn-secondary btn-sm" to="/connectors">Connectors</Link>
          </div>
        </header>

        <div className="agent-tools-strip">
          {connected.length === 0 ? (
            <span className="meta">No connectors on, <Link to="/connectors">connect one</Link> to give the agent tools.</span>
          ) : connected.map((c) => (
            <span key={c.id} className="tools-chip">
              <img src={`/assets/connectors/${c.id}.svg`} alt="" width="14" height="14" onError={(e) => { e.currentTarget.style.display = 'none'; }} />
              {c.name}
              {!!c.resources?.length && <em>{c.resources.length}</em>}
            </span>
          ))}
        </div>

        <AnimatePresence>
          {showSchedule && (
            <ScheduleBar
              threadId={threadId}
              onClose={() => setShowSchedule(false)}
              onSaved={(note) => { ok(note || 'Scheduled.'); setShowSchedule(false); setPlaybookNonce((n) => n + 1); }}
            />
          )}
        </AnimatePresence>

        <Playbooks nonce={playbookNonce} />

        {threads.length > 0 && (
          <div className="agent-threads">
            {threads.map((t) => (
              <button
                key={t.thread_uid}
                type="button"
                className={`thread-chip${t.thread_uid === threadId ? ' active' : ''}`}
                onClick={() => setThreadId(t.thread_uid)}
              >
                {t.title || 'Untitled'}
              </button>
            ))}
          </div>
        )}

        <div className="agent-messages" ref={scrollRef}>
          {visible.length === 0 && !live ? (
            <EmptyState icon="✦" title="Ask for the outcome, not the steps">
              The agent uses the connectors you have switched on, and every action it
              takes is recorded against your name.
              <div className="agent-suggestions">
                {SUGGESTIONS.map((s) => (
                  <button key={s} type="button" className="suggestion" onClick={() => send(s)}>{s}</button>
                ))}
              </div>
            </EmptyState>
          ) : (
            <>
              {visible.map((m) => (
                <motion.div
                  key={m.id}
                  className={`agent-msg agent-${m.role}`}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.26, ease: [0.22, 1, 0.36, 1] }}
                >
                  <div className="agent-bubble">{m.content}</div>
                  {!!m.tool_calls?.length && (
                    <div className="agent-trace">
                      {m.tool_calls.map((t, i) => <ToolCall key={t.id || i} call={t} />)}
                    </div>
                  )}
                </motion.div>
              ))}

              {live && (
                <motion.div
                  className="agent-msg agent-assistant"
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                >
                  {live.tools.length > 0 && (
                    <div className="agent-trace">
                      {live.tools.map((t) => <ToolCall key={t.id} call={t} live />)}
                    </div>
                  )}
                  <div className="agent-bubble">
                    {live.content || (
                      <span className="thinking">
                        {live.phase === 'tool' ? 'Running tools' : 'Thinking'}
                        <i /><i /><i />
                      </span>
                    )}
                  </div>
                </motion.div>
              )}
            </>
          )}
        </div>

        <form
          className="agent-composer"
          onSubmit={(e) => { e.preventDefault(); send(); }}
        >
          <Textarea
            ref={inputRef}
            rows={2}
            value={draft}
            placeholder="Ask the agent to check, fetch or update something…"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            disabled={busy}
            aria-label="Message the agent"
          />
          <Button variant="primary" type="submit" loading={busy} disabled={!draft.trim()}>
            Send
          </Button>
        </form>
      </div>
    </PageTransition>
  );
}
