import { Link } from 'react-router-dom';

const sampleContainers = [
  { name: 'api-gateway', image: 'node:22-alpine', state: 'Running', tone: 'good' },
  { name: 'worker-queue', image: 'redis:7', state: 'Running', tone: 'good' },
  { name: 'old-preview', image: 'nginx:alpine', state: 'Stopped', tone: 'quiet' },
];

export function LandingPage() {
  return (
    <main className="landing-page">
      <header className="landing-nav">
        <Link className="brand landing-brand" to="/" aria-label="DockerPilot home">
          <span className="brand-mark" aria-hidden="true"><span /></span>
          <span>docker<span className="brand-accent">pilot</span></span>
        </Link>
        <nav className="landing-links" aria-label="Main navigation">
          <a href="#product">Product</a>
          <a href="#features">Features</a>
          <a href="https://github.com/Harshil1307/DockerPilot/tree/main/docs" target="_blank" rel="noreferrer">Documentation <span aria-hidden="true">↗</span></a>
        </nav>
        <div className="landing-nav-actions">
          <Link className="landing-login" to="/login">Log in</Link>
          <Link className="landing-button landing-button-small" to="/register">Get started <span aria-hidden="true">↗</span></Link>
        </div>
      </header>

      <section className="landing-hero" id="product">
        <div className="landing-copy">
          <div className="landing-kicker"><span /> DOCKER, IN GOOD ORDER</div>
          <h1>Your Docker workflow.<br /><em>Under control.</em></h1>
          <p>Manage containers, monitor resources, deploy Compose environments and organize your Docker infrastructure from one workspace.</p>
          <div className="landing-hero-actions">
            <Link className="landing-button" to="/register">Get started <span aria-hidden="true">↗</span></Link>
            <a className="landing-text-link" href="#features">Explore the product <span aria-hidden="true">↓</span></a>
          </div>
          <div className="landing-footnote"><span className="landing-status-dot" /> Works with your local Docker Engine</div>
        </div>

        <div className="preview-stage" aria-label="Illustrative DockerPilot dashboard preview. All values shown are sample data.">
          <div className="preview-orbit preview-orbit-one" />
          <div className="preview-orbit preview-orbit-two" />
          <div className="preview-dashboard">
            <div className="preview-topbar">
              <span className="preview-brand-mark">D</span><strong>docker<span>pilot</span></strong>
              <span className="preview-sample-label">SAMPLE DATA</span>
              <div className="preview-user-dot">JD</div>
            </div>
            <div className="preview-layout">
              <div className="preview-sidebar" aria-hidden="true">
                <span className="preview-side-active">⌂ <i>Overview</i></span>
                <span>◈ <i>Containers</i></span>
                <span>▧ <i>Images</i></span>
                <span>▤ <i>Volumes</i></span>
                <span>⌘ <i>Networks</i></span>
              </div>
              <div className="preview-main">
                <div className="preview-heading-row"><div><small>WORKSPACE / LOCAL ENGINE</small><h2>Good morning, Jordan</h2></div><span className="preview-connected"><b /> Engine connected</span></div>
                <div className="preview-metrics">
                  <div><small>CONTAINERS</small><strong>08 <span>total</span></strong><p><b>5 running</b> · 3 stopped</p></div>
                  <div><small>CPU USAGE</small><strong>24<span>%</span></strong><div className="preview-meter"><i style={{ width: '24%' }} /></div></div>
                  <div><small>MEMORY</small><strong>3.2 <span>GB</span></strong><div className="preview-meter"><i style={{ width: '61%' }} /></div></div>
                </div>
                <div className="preview-lower">
                  <section className="preview-containers">
                    <div className="preview-section-title"><strong>Containers</strong><span>VIEW ALL ↗</span></div>
                    {sampleContainers.map((container) => <div className="preview-container-row" key={container.name}>
                      <span className="preview-cube">▣</span><span className="preview-container-name"><strong>{container.name}</strong><small>{container.image}</small></span><span className={`preview-state preview-state-${container.tone}`}><b />{container.state}</span>
                    </div>)}
                  </section>
                  <section className="preview-compose">
                    <div className="preview-section-title"><strong>Compose</strong><span>01 ENV</span></div>
                    <div className="preview-compose-card"><span className="preview-compose-icon">⌘</span><div><strong>storefront</strong><small>production · 3 services</small></div></div>
                    <div className="preview-compose-status"><b /> Running <span>Updated just now</span></div>
                  </section>
                </div>
                <div className="preview-activity"><span className="preview-activity-mark">↗</span><span><strong>Deployment started</strong><small>storefront · Compose environment</small></span><time>2m ago</time></div>
              </div>
            </div>
          </div>
          <div className="preview-float preview-float-health"><span className="preview-float-icon">⌁</span><span><small>ENGINE HEALTH</small><strong><i /> All systems ready</strong></span></div>
          <div className="preview-float preview-float-compose"><span className="preview-compose-icon">⌘</span><span><small>COMPOSE DEPLOYMENT</small><strong>storefront <i>RUNNING</i></strong></span></div>
          <p className="preview-caption">Illustrative interface · sample values, not live Docker metrics</p>
        </div>
      </section>

      <section className="landing-trustline" aria-label="Product capabilities">
        <span>ONE CLEAR VIEW</span><i />
        <span>YOUR ENGINE, YOUR MACHINE</span><i />
        <span>BUILT FOR THE WAY YOU SHIP</span>
      </section>

      <section className="landing-features" id="features">
        <div className="landing-section-intro"><div className="landing-kicker"><span /> THE ESSENTIALS</div><h2>Less context switching.<br /><em>More shipping.</em></h2><p>A calm workspace for the parts of Docker that deserve your attention.</p></div>
        <div className="landing-feature-list">
          <article className="landing-feature-row"><span className="landing-feature-number">01</span><div><h3>See the whole host</h3><p>Check engine health, containers and resource use in one clear overview.</p></div><span className="landing-feature-symbol">◫</span></article>
          <article className="landing-feature-row"><span className="landing-feature-number">02</span><div><h3>Run Compose with confidence</h3><p>Validate configurations, deploy environments, and follow their status and logs.</p></div><span className="landing-feature-symbol">⌘</span></article>
          <article className="landing-feature-row"><span className="landing-feature-number">03</span><div><h3>Keep your resources organized</h3><p>Inspect containers, images, volumes and networks without losing the thread.</p></div><span className="landing-feature-symbol">▱</span></article>
        </div>
      </section>

      <section className="landing-cta">
        <div><div className="landing-kicker"><span /> READY WHEN YOU ARE</div><h2>Bring your Docker workflow<br /><em>into focus.</em></h2></div>
        <Link className="landing-button" to="/register">Create your workspace <span aria-hidden="true">↗</span></Link>
      </section>

      <footer className="landing-footer"><Link className="brand landing-brand" to="/" aria-label="DockerPilot home"><span className="brand-mark" aria-hidden="true"><span /></span><span>docker<span className="brand-accent">pilot</span></span></Link><span>DOCKER, IN GOOD ORDER.</span><span>© {new Date().getFullYear()} DOCKERPILOT</span></footer>
    </main>
  );
}
