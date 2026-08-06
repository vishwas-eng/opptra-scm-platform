import { AnimatePresence, motion } from 'framer-motion';
import { useEffect, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { titleForPath, visibleNav } from '../nav.js';
import { Dot } from './ui.jsx';
import './shell.css';

const REGION_KEY = 'opptra_scm_region';

export function useRegion() {
  const [region, setRegion] = useState(() => localStorage.getItem(REGION_KEY) || 'india');
  useEffect(() => { localStorage.setItem(REGION_KEY, region); }, [region]);
  return [region, setRegion];
}

/** UC session health, polled slowly, it drives the topbar pill and the outage banner. */
function useUcHealth() {
  const [session, setSession] = useState(null);
  useEffect(() => {
    let alive = true;
    const load = () => api('/api/uc-session')
      .then((s) => { if (alive) setSession(s); })
      .catch(() => {}); // a transient failure must never blank the shell
    load();
    const t = setInterval(load, 30_000);
    return () => { alive = false; clearInterval(t); };
  }, []);
  return session;
}

export default function Shell({ children, region, setRegion }) {
  const { user, isAdmin, signOut } = useAuth();
  const location = useLocation();
  const session = useUcHealth();
  const items = visibleNav({ isAdmin, region });
  const title = titleForPath(location.pathname);

  const healthy = session?.status === 'alive' && !session?.needs_relogin;
  const healthTone = !session ? 'idle' : healthy ? 'ok' : 'bad';

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="side-brand">
          <img src="/assets/opptra-logo-white.svg" alt="Opptra" width="92" />
          <span className="brand-sub">SCM</span>
        </div>

        <nav className="side-nav" aria-label="Sections">
          {items.map((entry, i) => (
            entry.group ? (
              <div key={`g-${entry.group}-${i}`} className="side-group">{entry.group}</div>
            ) : (
              <NavLink
                key={entry.path}
                to={entry.path}
                end={entry.path === '/'}
                className={({ isActive }) => `side-link${isActive ? ' active' : ''}`}
              >
                <span className="side-icon" aria-hidden="true">{entry.icon}</span>
                <span className="side-label">{entry.label}</span>
                {entry.pill && <span className="side-pill">{entry.pill}</span>}
              </NavLink>
            )
          ))}
        </nav>

        <div className="side-foot">
          <div className="side-session">
            <Dot tone={healthTone} />
            <span>
              {!session ? 'Checking session…'
                : healthy ? `UC ${session.instance_id || 'india'} alive`
                  : 'UC session needs attention'}
            </span>
          </div>
        </div>
      </aside>

      <div className="content">
        <header className="topbar">
          <div className="topbar-title">
            <span className="eyebrow">Opptra SCM</span>
            <h2>{title}</h2>
          </div>

          <div className="topbar-right">
            <div className="region-toggle" role="group" aria-label="Region">
              {['india', 'gcc'].map((r) => (
                <button
                  key={r}
                  type="button"
                  className={region === r ? 'active' : ''}
                  onClick={() => setRegion(r)}
                >
                  {r === 'india' ? 'India' : 'GCC'}
                </button>
              ))}
            </div>

            <div className={`health-pill health-${healthTone}`} title={session?.status || 'unknown'}>
              <Dot tone={healthTone} />
              <span className="health-text">{healthy ? 'Connected' : session ? 'Session down' : '…'}</span>
            </div>

            <div className="user-chip">
              {user?.picture
                ? <img src={user.picture} alt="" width="26" height="26" referrerPolicy="no-referrer" />
                : <span className="user-initial">{(user?.name || user?.email || '?')[0].toUpperCase()}</span>}
              <div className="user-meta">
                <span className="user-name">{user?.name || user?.email}</span>
                <span className="user-role">{user?.role}</span>
              </div>
              <button type="button" className="logout" onClick={signOut} aria-label="Sign out">⏻</button>
            </div>
          </div>
        </header>

        <AnimatePresence>
          {session && !healthy && (
            <motion.div
              className="relogin-banner"
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
            >
              <span>
                The Unicommerce session for <strong>{session.instance_id || 'india'}</strong> is down, automations that talk to UC will fail until it is refreshed.
              </span>
              {isAdmin && <NavLink to="/schedules" className="banner-action">Reconnect</NavLink>}
            </motion.div>
          )}
        </AnimatePresence>

        <main className="main">{children}</main>
      </div>
    </div>
  );
}
