import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';

export function ProtectedRoute() {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return <main className="auth-loading"><span className="loading-indicator" /> Restoring your session…</main>;
  }
  if (!user) {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }
  return <Outlet />;
}

export function PublicOnlyRoute() {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) {
    return <main className="auth-loading"><span className="loading-indicator" /> Loading DockerPilot…</main>;
  }
  const requestedPath = (location.state as { from?: { pathname?: string } } | null)?.from?.pathname;
  const destination = requestedPath?.startsWith('/') && !requestedPath.startsWith('//') ? requestedPath : '/';
  return user ? <Navigate to={destination} replace /> : <Outlet />;
}
