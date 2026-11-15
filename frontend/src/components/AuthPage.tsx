import { useEffect, useState, type FormEvent } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { getGoogleAuthConfig, googleAuthStartUrl } from '../lib/api';

interface AuthPageProps { mode: 'login' | 'register' }

function GoogleMark() {
  return <svg aria-hidden="true" viewBox="0 0 48 48" width="19" height="19"><path fill="#4285F4" d="M43.6 24.5c0-1.4-.1-2.8-.4-4.1H24v7.8h11a9.4 9.4 0 0 1-4.1 6.2v5.1h6.7c3.9-3.6 6-8.8 6-15Z"/><path fill="#34A853" d="M24 44c5.5 0 10.1-1.8 13.5-4.8l-6.7-5.1c-1.8 1.2-4.1 2-6.8 2-5.2 0-9.6-3.5-11.2-8.2H5.9v5.2A20 20 0 0 0 24 44Z"/><path fill="#FBBC05" d="M12.8 27.9a12 12 0 0 1 0-7.8v-5.2H5.9a20 20 0 0 0 0 18.2l6.9-5.2Z"/><path fill="#EA4335" d="M24 11.9c3 0 5.7 1 7.8 3.1l5.8-5.8C34.1 5.8 29.5 4 24 4A20 20 0 0 0 5.9 14.9l6.9 5.2c1.6-4.7 6-8.2 11.2-8.2Z"/></svg>;
}

export function AuthPage({ mode }: AuthPageProps) {
  const isRegister = mode === 'register';
  const { user, loading, login, register } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [googleEnabled, setGoogleEnabled] = useState(false);

  useEffect(() => {
    let active = true;
    getGoogleAuthConfig().then((config) => { if (active) setGoogleEnabled(config.enabled); }).catch(() => { if (active) setGoogleEnabled(false); });
    const outcome = new URLSearchParams(location.search).get('google');
    if (outcome === 'cancelled') setError('Google sign-in was cancelled. You can try again or continue with email.');
    else if (outcome === 'failed') setError('Google sign-in could not be completed. Try again or continue with email.');
    return () => { active = false; };
  }, [location.search]);

  if (loading) return <main className="auth-loading"><span className="loading-indicator" /> Loading DockerPilot…</main>;
  const requestedPath = (location.state as { from?: { pathname?: string } } | null)?.from?.pathname;
  const destination = requestedPath?.startsWith('/') && !requestedPath.startsWith('//') ? requestedPath : '/';
  if (user) return <Navigate to={destination} replace />;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(null);
    if (isRegister && !name.trim()) { setError('Enter your name.'); return; }
    if (!email.trim()) { setError('Enter your email address.'); return; }
    if (isRegister && password.length < 12) { setError('Use at least 12 characters for your password.'); return; }
    if (!isRegister && !password) { setError('Enter your password.'); return; }
    setSubmitting(true);
    try {
      if (isRegister) await register({ name: name.trim(), email: email.trim(), password });
      else await login({ email: email.trim(), password });
      navigate(destination, { replace: true });
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not complete your request.'); }
    finally { setSubmitting(false); }
  }

  return <main className="auth-page auth-page-unified">
    <section className="auth-entry" aria-label={isRegister ? 'Create a DockerPilot account' : 'Sign in to DockerPilot'}>
      <Link className="brand auth-brand" to="/" aria-label="DockerPilot home"><span className="brand-mark" aria-hidden="true">D</span><span>docker<span className="brand-accent">pilot</span></span></Link>
      <div className="auth-entry-title"><p className="auth-kicker">DOCKERPILOT WORKSPACE</p><h1>{isRegister ? 'Create your account' : 'Sign in'}</h1><p>{isRegister ? 'Register projects and inspect the Docker environments you own.' : 'Continue to your projects and Docker environments.'}</p></div>
      {googleEnabled && <><a className="google-signin-button" href={googleAuthStartUrl()}><GoogleMark /><span>Continue with Google</span></a><div className="auth-divider"><span>or continue with email</span></div></>}
      <form className="project-form auth-form" onSubmit={handleSubmit} noValidate>
        {isRegister && <label className="form-field"><span>Your name</span><input autoComplete="name" autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="Name" maxLength={100} /></label>}
        <label className="form-field"><span>Email address</span><input type="email" autoComplete="email" autoFocus={!isRegister} value={email} onChange={(event) => setEmail(event.target.value)} placeholder="name@example.com" maxLength={254} /></label>
        <div className="form-field"><span>Password</span><span className="password-input-wrap"><input aria-label="Password" type={showPassword ? 'text' : 'password'} autoComplete={isRegister ? 'new-password' : 'current-password'} value={password} onChange={(event) => setPassword(event.target.value)} placeholder={isRegister ? 'At least 12 characters' : 'Password'} /><button className="password-visibility" type="button" onClick={() => setShowPassword((value) => !value)} aria-label={showPassword ? 'Hide' : 'Show'}>{showPassword ? 'Hide' : 'Show'}</button></span></div>
        {error && <div className="form-message error-message" role="alert">{error}</div>}
        <button className="primary-button auth-submit" type="submit" disabled={submitting}>{submitting ? 'Please wait…' : isRegister ? 'Create account' : 'Sign in'}</button>
      </form>
      <p className="auth-switch">{isRegister ? 'Already have an account?' : 'New to DockerPilot?'}{' '}<Link to={isRegister ? '/login' : '/register'}>{isRegister ? 'Sign in' : 'Create an account'}</Link></p>
    </section>
    <p className="auth-footer">DOCKERPILOT · DOCKER OPERATIONS</p>
  </main>;
}
