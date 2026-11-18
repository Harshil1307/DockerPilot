import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { FormEvent, ReactNode } from 'react';
import { askBrain, getBrainDashboard, type BrainDashboard } from '../lib/api';

function bytes(value: number | null) {
  if (value === null) return 'Unavailable';
  return value < 1024 * 1024 ? (value / 1024).toFixed(0) + ' KiB' : (value / 1024 / 1024).toFixed(1) + ' MiB';
}
type Message = { role: 'user' | 'assistant'; content: string };

function inlineText(value: string, prefix: string): ReactNode[] {
  return value.split(/(\*\*[^*]+\*\*|__[^_]+__|`[^`]+`|\*[^*]+\*)/g).filter(Boolean).map((part, index) => {
    const key = `${prefix}-${index}`;
    if ((part.startsWith('**') && part.endsWith('**')) || (part.startsWith('__') && part.endsWith('__'))) return <strong key={key}>{part.slice(2, -2)}</strong>;
    if (part.startsWith('`') && part.endsWith('`')) return <code key={key}>{part.slice(1, -1)}</code>;
    if (part.startsWith('*') && part.endsWith('*')) return <em key={key}>{part.slice(1, -1)}</em>;
    return part;
  });
}

function AssistantReply({ content }: { content: string }) {
  const blocks: ReactNode[] = [];
  let paragraph: string[] = [];
  let bullets: string[] = [];
  const flushParagraph = () => {
    if (!paragraph.length) return;
    blocks.push(<p key={`p-${blocks.length}`}>{inlineText(paragraph.join(' '), `p-${blocks.length}`)}</p>);
    paragraph = [];
  };
  const flushBullets = () => {
    if (!bullets.length) return;
    blocks.push(<ul key={`ul-${blocks.length}`}>{bullets.map((item, index) => <li key={`li-${index}`}>{inlineText(item, `li-${index}`)}</li>)}</ul>);
    bullets = [];
  };
  for (const line of content.trim().split(/\r?\n/)) {
    const heading = line.match(/^#{1,6}\s+(.+)$/);
    const bullet = line.match(/^\s*[-*+]\s+(.+)$/);
    const numbered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (!line.trim()) { flushParagraph(); flushBullets(); continue; }
    if (heading) {
      flushParagraph(); flushBullets();
      blocks.push(<h4 key={`h-${blocks.length}`}>{inlineText(heading[1]!, `h-${blocks.length}`)}</h4>);
    } else if (bullet || numbered) {
      flushParagraph(); bullets.push((bullet?.[1] ?? numbered?.[1])!);
    } else {
      flushBullets(); paragraph.push(line.trim());
    }
  }
  flushParagraph(); flushBullets();
  return <div className="brain-reply">{blocks}</div>;
}

function containerCount(count: number) { return `${count} ${count === 1 ? 'container' : 'containers'}`; }
export function AIBrainPage() {
  const [data, setData] = useState<BrainDashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [question, setQuestion] = useState('');
  const [sending, setSending] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const sampledCpu = data?.containers.reduce((sum, item) => sum + (item.cpuPercent ?? 0), 0) ?? null;
  const sampledMemory = data?.containers.reduce((sum, item) => sum + (item.memoryUsageBytes ?? 0), 0) ?? null;
  const refresh = useCallback(async () => {
    setLoading(true); setError(null);
    try { setData(await getBrainDashboard()); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not sample Docker data.'); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void refresh(); const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void refresh(); }, 30_000); return () => window.clearInterval(timer); }, [refresh]);
  async function submit(event: FormEvent) {
    event.preventDefault(); const value = question.trim();
    if (!value || sending) return;
    const next = [...messages, { role: 'user' as const, content: value }];
    setMessages(next); setQuestion(''); setSending(true); setChatError(null);
    try {
      const result = await askBrain(value, messages.slice(-8));
      setMessages([...next, { role: 'assistant', content: result.answer }]);
    } catch (cause) { setChatError(cause instanceof Error ? cause.message : 'AI chat is unavailable.'); }
    finally { setSending(false); }
  }
  return <main className="brain-page">
    <div className="page-heading"><div className="eyebrow"><span className="eyebrow-line" /> DOCKER INTELLIGENCE</div><h1>AI Brain</h1><p>Live Docker evidence, practical diagnostics, and environment aware answers.</p></div>
    {error && <div className="form-message error-message" role="alert">{error} <button className="secondary-button" onClick={() => void refresh()}>Retry</button></div>}
    {data?.message && <div className="form-message error-message" role="status">{data.message}</div>}
    <section className="brain-status-row" aria-label="AI Brain status">
      <div><span>AI BRAIN</span><strong>{loading ? 'Sampling…' : data?.status === 'ready' ? 'Connected to Docker' : 'Docker unavailable'}</strong></div>
      <div><span>SYSTEM HEALTH</span><strong>{data?.systemHealth ?? '—'}</strong></div>
      <div><span>CONTAINERS ANALYSED</span><strong>{data?.containerCount ?? '—'}</strong></div>
      <div><span>WARNINGS / CRITICAL</span><strong>{data ? data.warnings + ' / ' + data.criticalIssues : '—'}</strong></div>
      <div><span>CPU SAMPLE SUM</span><strong>{sampledCpu === null ? '—' : sampledCpu.toFixed(1) + '%'}</strong></div>
      <div><span>MEMORY IN USE</span><strong>{sampledMemory === null ? '—' : bytes(sampledMemory)}</strong></div>
      <button className="secondary-button" onClick={() => void refresh()} disabled={loading}>Refresh sample</button>
    </section>
    <section className="brain-grid">
      <article className="brain-card"><div className="brain-card-heading"><div><span className="eyebrow">RESOURCE MONITOR</span><h2>Highest CPU</h2></div></div>{data?.topCpu.length ? data.topCpu.map((item) => <div className="brain-resource" key={item.id}><strong>{item.name}</strong><span>{item.cpuPercent?.toFixed(1)}%</span><small>{item.state} · {item.image}</small></div>) : <p className="brain-empty">{loading ? 'Collecting metrics…' : 'No CPU samples available.'}</p>}</article>
      <article className="brain-card"><div className="brain-card-heading"><div><span className="eyebrow">RESOURCE MONITOR</span><h2>Highest memory</h2></div></div>{data?.topMemory.length ? data.topMemory.map((item) => <div className="brain-resource" key={item.id}><strong>{item.name}</strong><span>{bytes(item.memoryUsageBytes)}</span><small>{item.memoryLimitBytes ? 'of ' + bytes(item.memoryLimitBytes) : 'No limit reported'} · {item.image}</small></div>) : <p className="brain-empty">{loading ? 'Collecting metrics…' : 'No memory samples available.'}</p>}</article>
      <article className="brain-card brain-wide"><div className="brain-card-heading"><div><span className="eyebrow">DETECTED FROM CURRENT EVIDENCE</span><h2>Alerts</h2></div><span>{data?.anomalies.length ?? 0} active</span></div>{data?.anomalies.length ? data.anomalies.map((item, index) => <details className="brain-alert" key={item.container + item.title + index}><summary><b className={item.severity}>{item.severity}</b><strong>{item.title}</strong><span>{item.container}</span></summary><p>{item.evidence}</p><p><b>Recommended:</b> {item.recommendation}</p></details>) : <p className="brain-empty">{loading ? 'Checking container health…' : 'No active warnings in this sample.'}</p>}</article>
      <article className="brain-card"><div className="brain-card-heading"><div><span className="eyebrow">DOCKER EVENTS</span><h2>Recent container events</h2></div><span>Last 15 minutes</span></div>{data?.eventsUnavailable ? <p className="brain-empty">Docker events are unavailable from this Engine or agent.</p> : data?.events.length ? data.events.slice(-8).reverse().map((event, index) => <div className="brain-resource" key={event.id + event.time + index}><strong>{event.name}</strong><span>{event.action}</span><small>{new Date(event.time).toLocaleTimeString()} · {event.image ?? 'Image unavailable'}</small></div>) : <p className="brain-empty">{loading ? 'Reading recent events…' : 'No account-owned container events in this window.'}</p>}</article>
      <article className="brain-card brain-wide"><div className="brain-card-heading"><div><span className="eyebrow">CONTAINER HEALTH</span><h2>Runtime and uptime</h2></div></div>{data?.containers.length ? data.containers.slice(0, 20).map((item) => <div className="brain-resource" key={item.id}><strong>{item.name}</strong><span>{item.state}{item.health ? ' · ' + item.health : ''}</span><small>{item.state === 'running' && item.startedAt ? 'Uptime ' + Math.max(0, Math.floor((Date.now() - Date.parse(item.startedAt)) / 3_600_000)) + ' hours' : 'Exit code ' + (item.exitCode ?? 'unavailable')} · {item.restartCount ?? 'Restart count unavailable'} restarts</small></div>) : <p className="brain-empty">{loading ? 'Inspecting runtime state…' : 'No account-owned containers are available to analyse.'}</p>}</article>
      <article className="brain-card"><div className="brain-card-heading"><div><span className="eyebrow">OPTIMISATION</span><h2>Recommendations</h2></div></div>{data?.recommendations.length ? data.recommendations.map((item) => <div className="brain-recommendation" key={item.title}><strong>{item.title}</strong><p>{item.reason}</p></div>) : <p className="brain-empty">{loading ? 'Analysing…' : 'No immediate changes suggested.'}</p>}</article>
      <article className="brain-card"><div className="brain-card-heading"><div><span className="eyebrow">SMART AUTO-SLEEP</span><h2>Possible idle containers</h2></div><Link className="secondary-button" to="/smart-sleep">Review</Link></div>{data?.idleCandidates.length ? data.idleCandidates.map((item) => <div className="brain-recommendation" key={item.name}><strong>{item.name}</strong><p>{item.reason} {item.inactivity} Memory {bytes(item.memoryUsageBytes)}. Review manually; nothing is stopped automatically.</p></div>) : <p className="brain-empty">{loading ? 'Checking samples…' : 'No safe idle candidates identified.'}</p>}</article>
      <article className="brain-card"><div className="brain-card-heading"><div><span className="eyebrow">RECENT DIAGNOSES</span><h2>Stack Doctor history</h2></div></div>{data?.recentDiagnoses.length ? data.recentDiagnoses.map((scan) => <div className="brain-recommendation" key={scan.id}><strong>{scan.project.name} · {scan.report.healthScore}/100</strong><p>{new Date(scan.createdAt).toLocaleString()} · {scan.report.criticalCount} critical · {scan.report.warningCount} warnings</p></div>) : <p className="brain-empty">Run Stack Doctor from a project to see its diagnoses here.</p>}</article>
      <article className="brain-card brain-wide"><div className="brain-card-heading"><div><span className="eyebrow">HISTORY</span><h2>Recent resource samples</h2></div><span>Stored for 30 days</span></div>{data?.history.length ? <div className="brain-history">{data.history.slice(0, 8).map((item) => { const snap = item.data as { containerCount?: number; warningCount?: number; criticalCount?: number }; return <div key={item.sampledAt}><span>{new Date(item.sampledAt).toLocaleString()}</span><strong>{typeof snap.containerCount === 'number' ? containerCount(snap.containerCount) : 'Container count unavailable'}</strong><span>{snap.warningCount ?? 0} warnings · {snap.criticalCount ?? 0} critical</span></div>; })}</div> : <p className="brain-empty">A sample is saved whenever you open or refresh this dashboard.</p>}</article>
    </section>
    <section className="brain-chat"><div className="brain-card-heading"><div><span className="eyebrow">CONTEXTUAL ASSISTANT</span><h2>Ask about this Docker environment</h2></div></div>
      <div className="brain-messages" aria-live="polite">{messages.length ? messages.map((message, index) => <div className={'brain-message ' + message.role} key={index + message.role}><b>{message.role === 'user' ? 'You' : 'AI Brain'}</b>{message.role === 'assistant' ? <AssistantReply content={message.content} /> : <p>{message.content}</p>}</div>) : <p className="brain-empty">Try “Which container has the most memory use?” or “Why is this container unhealthy?” Answers use a fresh, redacted Docker snapshot.</p>}{sending && <p className="brain-empty" role="status">AI Brain is reviewing the current Docker data…</p>}</div>
      {chatError && <div className="form-message error-message" role="alert">{chatError}</div>}
      <form onSubmit={(event) => void submit(event)} className="brain-chat-form"><input value={question} onChange={(event) => setQuestion(event.target.value)} maxLength={2000} placeholder="Ask a question about your containers…" aria-label="Question for AI Brain"/><button className="primary-button" disabled={sending || !question.trim()}>{sending ? 'Thinking…' : 'Ask AI Brain'}</button></form>
      <small>Chat uses the Gemini key in backend/.env. Your Docker data is sent to Gemini to answer; the assistant never runs commands.</small>
    </section>
  </main>;
}
