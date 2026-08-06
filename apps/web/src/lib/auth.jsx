import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, setUnauthorizedHandler } from './api.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [config, setConfig] = useState(null);
  const [booting, setBooting] = useState(true);

  // A 401 from ANY call means the session is gone; drop to the login view once,
  // globally, instead of every caller inventing its own handling.
  useEffect(() => {
    setUnauthorizedHandler(() => setUser(null));
    return () => setUnauthorizedHandler(null);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [cfg, me] = await Promise.all([
        api('/api/config').catch(() => ({})),
        api('/api/me').catch(() => null),
      ]);
      if (cancelled) return;
      setConfig(cfg || {});
      setUser(me?.user || null);
      setBooting(false);
    })();
    return () => { cancelled = true; };
  }, []);

  const signIn = useCallback((u) => setUser(u), []);

  const signOut = useCallback(async () => {
    await api('/auth/logout', { body: {} }).catch(() => {});
    // Full reload rather than state reset: it clears every cache, in-flight poll and
    // object URL in one step, which is exactly what signing out should mean.
    window.location.assign('/');
  }, []);

  const value = useMemo(() => ({
    user,
    config,
    booting,
    isAdmin: user?.role === 'admin',
    signIn,
    signOut,
  }), [user, config, booting, signIn, signOut]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
