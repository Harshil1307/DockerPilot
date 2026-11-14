import { useCallback, useEffect, useState } from 'react';
import { createLocalAgentPairingChallenge, listLocalAgents, revokeLocalAgent, type LocalAgent } from '../lib/api';

interface PairingChallenge {
  code: string;
  expiresAt: string;
}

export function LocalAgentPanel({ localEngineReachable }: { localEngineReachable: boolean | null }) {
  const [agents, setAgents] = useState<LocalAgent[]>([]);
  const [pairing, setPairing] = useState<PairingChallenge | null>(null);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const response = await listLocalAgents();
      setAgents(response.agents);
      setError(null);
    } catch (cause) {
      if (!quiet) setError(cause instanceof Error ? cause.message : 'Could not check local Docker agents.');
    } finally {
      if (!quiet) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh(true);
    }, 15_000);
    return () => window.clearInterval(interval);
  }, [refresh]);

  const visible = localEngineReachable === false || agents.length > 0 || Boolean(pairing);
  if (!visible) return null;

  async function startPairing() {
    setWorking(true);
    setError(null);
    setNotice(null);
    try {
      setPairing(await createLocalAgentPairingChallenge());
      setNotice('Pairing code created. It expires in five minutes and can only be used once.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not create a pairing code.');
    } finally {
      setWorking(false);
    }
  }

  async function copyCode() {
    if (!pairing) return;
    try {
      await navigator.clipboard.writeText(pairing.code);
      setNotice('Pairing code copied. Paste it into the agent prompt in Terminal.');
    } catch {
      setError('Could not copy the pairing code. Select and copy it from the box.');
    }
  }

  async function revoke(agent: LocalAgent) {
    if (!window.confirm(`Revoke “${agent.name}”? That computer will lose access to this DockerPilot account.`)) return;
    setWorking(true);
    setError(null);
    try {
      await revokeLocalAgent(agent.id);
      setAgents((current) => current.map((item) => item.id === agent.id ? { ...item, connected: false, revokedAt: new Date().toISOString() } : item));
      setNotice('Agent access revoked.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not revoke this agent.');
    } finally {
      setWorking(false);
    }
  }

  const activeAgent = agents.find((agent) => !agent.revokedAt);

  return <section className="local-agent-panel" aria-labelledby="local-agent-heading">
    <div className="local-agent-copy">
      <div className="eyebrow"><span className="eyebrow-line" /> LOCAL DOCKER CONNECTION</div>
      <h2 id="local-agent-heading">Connect this computer</h2>
      <p>The hosted site reaches your Docker Engine through a small agent running on your computer. The agent connects outward; your Docker socket stays private.</p>
    </div>

    {loading ? <p className="local-agent-status" role="status">Checking paired computers…</p> : activeAgent ? <div className="local-agent-device">
      <span className={`local-agent-dot${activeAgent.connected ? ' is-connected' : ''}`} aria-hidden="true" />
      <span><strong>{activeAgent.name}</strong><small>{activeAgent.connected ? 'Connected to DockerPilot' : 'Paired; start the agent on this computer to connect'}</small></span>
      <button className="danger-button" type="button" onClick={() => void revoke(activeAgent)} disabled={working}>Revoke</button>
    </div> : <div className="local-agent-actions">
      <p>Pair your expo computer with the account you’re signed into here.</p>
      <button className="primary-button" type="button" onClick={() => void startPairing()} disabled={working}>{working ? 'Creating code…' : 'Pair this computer'}</button>
    </div>}

    {pairing && <div className="local-agent-pairing">
      <div><strong>1. Copy this one-time code</strong><small>Expires {new Date(pairing.expiresAt).toLocaleTimeString()}.</small></div>
      <div className="local-agent-code-row"><code>{pairing.code}</code><button className="secondary-button" type="button" onClick={() => void copyCode()}>Copy code</button></div>
      <div><strong>2. Start the local agent</strong><small>In Terminal, from the DockerPilot project folder, run:</small><code className="local-agent-command">npm run agent:dev --workspace @dockerpilot/backend -- pair</code><small>Paste the code when prompted and keep that Terminal window open during your demo.</small></div>
    </div>}

    {error && <p className="local-agent-message is-error" role="alert">{error}</p>}
    {notice && <p className="local-agent-message" role="status">{notice}</p>}
    {agents.some((agent) => agent.revokedAt) && <details className="local-agent-revoked"><summary>Revoked devices</summary><ul>{agents.filter((agent) => agent.revokedAt).map((agent) => <li key={agent.id}>{agent.name} · revoked {new Date(agent.revokedAt!).toLocaleString()}</li>)}</ul></details>}
  </section>;
}
