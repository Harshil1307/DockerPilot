import { useState, type FormEvent } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';

interface AuthPageProps {
  mode: 'login' | 'register';
}

export function AuthPage({ mode }: AuthPageProps) {
  const isRegister = mode === 'register';
  const { user, loading, login, register } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (loading) return <main className="auth-loading"><span className="loading-indicator" /> Loading DockerPilot…</main>;
  const requestedPath = (location.state as { from?: { pathname?: string } } | null)?.from?.pathname;
  const destination = requestedPath?.startsWith('/') && !requestedPath.startsWith('//') ? requestedPath : '/';
  if (user) return <Navigate to={destination} replace />;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    if (isRegister && !name.trim()) {
      setError('Enter your name.');
      return;
    }
    if (!email.trim()) {
      setError('Enter your email address.');
      return;
    }
    if (isRegister && password.length < 12) {
      setError('Use at least 12 characters for your password.');
      return;
    }
    if (!isRegister && !password) {
      setError('Enter your password.');
      return;
    }

    setSubmitting(true);
    try {
      if (isRegister) await register({ name: name.trim(), email: email.trim(), password });
      else await login({ email: email.trim(), password });
      navigate(destination, { replace: true });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not complete your request.');
    } finally {
      setSubmitting(false);
    }
  }

  if (!isRegister) {
    return (
      <main className="auth-page auth-page-login">
        <section className="auth-login-identity" aria-label="DockerPilot">
          <Link className="brand auth-brand" to="/" aria-label="DockerPilot home">
            <span className="brand-mark" aria-hidden="true">D</span>
            <span>docker<span className="brand-accent">pilot</span></span>
          </Link>
          <div className="auth-login-story">
            <p className="auth-login-kicker">A clear view of your Docker workspace</p>
            <h1>Docker, in<br />good order.</h1>
            <p>Inspect your host, organize projects, and manage Compose environments from one considered workspace.</p>
          </div>
          <p className="auth-workspace-map">Host <span>→</span> Projects <span>→</span> Compose</p>
        </section>
        <section className="auth-login-entry" aria-label="Sign in to DockerPilot">
          <div className="auth-login-form">
            <p className="auth-login-kicker">Your workspace is ready</p>
            <h2>Sign in</h2>
            <form className="project-form auth-form" onSubmit={handleSubmit} noValidate>
              <label className="form-field"><span>Email address</span><input type="email" autoComplete="email" autoFocus value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" maxLength={254} /></label>
              <label className="form-field"><span>Password</span><input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Your password" /></label>
              {error && <div className="form-message error-message" role="alert">{error}</div>}
              <button className="primary-button auth-submit" type="submit" disabled={submitting}>{submitting ? 'Please wait…' : 'Sign in'}</button>
            </form>
            <p className="auth-switch">New to DockerPilot? <Link to="/register">Create an account</Link></p>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="auth-page">
      <Link className="brand auth-brand" to="/" aria-label="DockerPilot home">
        <span className="brand-mark" aria-hidden="true">D</span>
        <span>docker<span className="brand-accent">pilot</span></span>
      </Link>
      <section className="auth-panel">
        <div className="eyebrow"><span className="eyebrow-line" /> DOCKERPILOT WORKSPACE</div>
        <h1>{isRegister ? 'Create your account' : 'Welcome back'}</h1>
        <p className="auth-intro">{isRegister ? 'Create an account to register and manage your projects.' : 'Sign in to continue to your projects.'}</p>
        <form className="project-form auth-form" onSubmit={handleSubmit} noValidate>
          {isRegister && <label className="form-field"><span>Your name</span><input autoComplete="name" autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="Your name" maxLength={100} /></label>}
          <label className="form-field"><span>Email address</span><input type="email" autoComplete="email" autoFocus={!isRegister} value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" maxLength={254} /></label>
          <label className="form-field"><span>Password</span><input type="password" autoComplete={isRegister ? 'new-password' : 'current-password'} value={password} onChange={(event) => setPassword(event.target.value)} placeholder={isRegister ? 'At least 12 characters' : 'Your password'} /></label>
          {error && <div className="form-message error-message" role="alert">{error}</div>}
          <button className="primary-button auth-submit" type="submit" disabled={submitting}>{submitting ? 'Please wait…' : isRegister ? 'Create account' : 'Sign in'}</button>
        </form>
        <p className="auth-switch">{isRegister ? 'Already have an account?' : 'New to DockerPilot?'}{' '}
          <Link to={isRegister ? '/login' : '/register'}>{isRegister ? 'Sign in' : 'Create an account'}</Link>
        </p>
      </section>
      <p className="auth-footer">YOUR PROJECTS, UNDER CONTROL.</p>
    </main>
  );
}
