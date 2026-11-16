import { useCallback, useEffect, useState } from 'react';
import { createLocalAgentPairingChallenge, listLocalAgents, revokeLocalAgent, type LocalAgent } from '../lib/api';
import { useConfirm } from './ConfirmDialog';

interface PairingChallenge {
  code: string;
  expiresAt: string;
}

export function LocalAgentPanel({ localEngineReachable }: { localEngineReachable: boolean | null }) {
  const confirm = useConfirm();
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
      setNotice('Pairing code copied. Paste it into the DockerPilot Agent prompt in Terminal.');
    } catch {
      setError('Could not copy the pairing code. Select and copy it from the box.');
    }
  }

  async function revoke(agent: LocalAgent) {
    if (!await confirm({ title: `Revoke “${agent.name}”?`, message: 'That computer will lose access to this DockerPilot account.', confirmLabel: 'Revoke access', destructive: true })) return;
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
      <h2 id="local-agent-heading">Welcome to DockerPilot. Let’s connect your Docker environment.</h2>
      <p>Follow these steps in order. Docker runs on your computer; the hosted site reaches it through an encrypted outbound agent connection. Your Docker socket is never published.</p>
    </div>

    <ol className="setup-steps">
      <li>
        <strong>Install and open Docker Desktop</strong>
        <p>Choose the installer for your computer from <a href="https://www.docker.com/products/docker-desktop/" target="_blank" rel="noreferrer">Docker’s official download page</a>. Launch Docker Desktop and wait until it says the engine is running.</p>
        <p>On macOS, choose Apple silicon or Intel to match your Mac. On Windows 10/11, install Docker Desktop and use its recommended WSL 2 backend when prompted.</p>
      </li>
      <li>
        <strong>Verify the Docker Engine</strong>
        <p>Open Terminal on macOS or PowerShell on Windows and run:</p>
        <code className="local-agent-command">docker version</code>
        <p>You should see both <b>Client</b> and <b>Server</b> sections. If Server is missing, open Docker Desktop, wait for it to finish starting, then retry.</p>
      </li>
      <li>
        <strong>Install the DockerPilot Agent</strong>
        <p>Standalone Windows and macOS installers are not published yet. For this preview, install <a href="https://git-scm.com/downloads" target="_blank" rel="noreferrer">Git</a> and <a href="https://nodejs.org/en/download" target="_blank" rel="noreferrer">Node.js 22</a>. PostgreSQL is not needed to connect this computer to the hosted site.</p>
        <div className="local-agent-commands">
          <code className="local-agent-command">git clone https://github.com/Harshil1307/DockerPilot.git</code>
          <code className="local-agent-command">cd DockerPilot</code>
          <code className="local-agent-command">npm ci</code>
        </div>
      </li>
      <li>
        <strong>Pair this computer</strong>
        <p>Generate a short-lived code here, then run the pairing command in a terminal inside the DockerPilot folder. Paste the code when the agent asks for it.</p>
      </li>
      <li>
        <strong>Verify the connection</strong>
        <p>Wait for this computer to show Connected. DockerPilot will then load the containers from this computer into the dashboard. If it stays offline, keep Docker Desktop open and the agent terminal running, then retry.</p>
      </li>
    </ol>

    {loading ? <p className="local-agent-status" role="status">Checking paired computers…</p> : activeAgent ? <div className="local-agent-device">
      <span className={`local-agent-dot${activeAgent.connected ? ' is-connected' : ''}`} aria-hidden="true" />
      <span><strong>{activeAgent.name}</strong><small>{activeAgent.connected ? 'Connected to DockerPilot. Your containers will appear after the next refresh.' : 'Paired, but currently offline. Start the agent and ensure Docker Desktop is running.'}</small></span>
      <button className="danger-button" type="button" onClick={() => void revoke(activeAgent)} disabled={working}>Revoke</button>
    </div> : <div className="local-agent-actions">
      <p>Ready when Docker Desktop is running and the preview agent is installed.</p>
      <button className="primary-button" type="button" onClick={() => void startPairing()} disabled={working}>{working ? 'Creating code…' : 'Generate pairing code'}</button>
    </div>}

    {pairing && <div className="local-agent-pairing">
      <div><strong>Pairing code</strong><small>Expires {new Date(pairing.expiresAt).toLocaleTimeString()} and can be used once.</small></div>
      <div className="local-agent-code-row"><code>{pairing.code}</code><button className="secondary-button" type="button" onClick={() => void copyCode()}>Copy code</button></div>
      <div><strong>Run the agent</strong><small>In Terminal or PowerShell, from the DockerPilot folder:</small><code className="local-agent-command">npm run agent:dev --workspace @dockerpilot/backend -- pair</code><small>Keep this window open while using DockerPilot. The agent reconnects after temporary network interruptions.</small></div>
    </div>}

    <details className="local-agent-revoked developer-setup">
      <summary>Developer setup: run DockerPilot’s backend and PostgreSQL locally</summary>
      <p>This section is for developing or self-hosting DockerPilot. Ordinary hosted users do not need PostgreSQL, a backend `.env` file, or these commands.</p>
      <ol>
        <li>Copy the checked-in examples and install dependencies. In macOS Terminal:<div className="local-agent-commands"><code className="local-agent-command">cp .env.example .env</code><code className="local-agent-command">cp backend/.env.example backend/.env</code><code className="local-agent-command">npm ci</code></div>In Windows PowerShell:<div className="local-agent-commands"><code className="local-agent-command">Copy-Item .env.example .env</code><code className="local-agent-command">Copy-Item backend/.env.example backend/.env</code><code className="local-agent-command">npm ci</code></div></li>
        <li>Start the PostgreSQL service defined in this repository’s <code>docker-compose.yml</code>:<code className="local-agent-command">docker compose up -d postgres</code></li>
        <li>Generate Prisma and apply local development migrations:<div className="local-agent-commands"><code className="local-agent-command">npm run db:generate</code><code className="local-agent-command">npm run db:migrate --workspace backend</code></div></li>
        <li>Start the API and website:<code className="local-agent-command">npm run dev</code></li>
      </ol>
      <p>For connecting only the preview agent to the hosted website, run the pairing command above. Its own process does not connect to PostgreSQL.</p>
    </details>

    {error && <p className="local-agent-message is-error" role="alert">{error}</p>}
    {notice && <p className="local-agent-message" role="status">{notice}</p>}
    {agents.some((agent) => agent.revokedAt) && <details className="local-agent-revoked"><summary>Revoked devices</summary><ul>{agents.filter((agent) => agent.revokedAt).map((agent) => <li key={agent.id}>{agent.name} · revoked {new Date(agent.revokedAt!).toLocaleString()}</li>)}</ul></details>}
  </section>;
}
