import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  fetchCurrentUser,
  loginAccount,
  logoutAccount,
  registerAccount,
  type Credentials,
  type User,
} from '../lib/api';

interface AuthContextValue {
  user: User | null;
  loading: boolean;
  login: (credentials: Credentials) => Promise<void>;
  register: (input: Credentials & { name: string }) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    fetchCurrentUser().then(
      (currentUser) => { if (active) setUser(currentUser); },
      () => { if (active) setUser(null); },
    ).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  const value = useMemo<AuthContextValue>(() => ({
    user,
    loading,
    async login(credentials) { setUser(await loginAccount(credentials)); },
    async register(input) { setUser(await registerAccount(input)); },
    async logout() { await logoutAccount(); setUser(null); },
  }), [user, loading]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within AuthProvider.');
  return context;
}
