import { motion } from 'framer-motion';
import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { Button } from '../components/ui.jsx';
import './login.css';

// Google Identity Services can fail to arrive for reasons the user can act on (ad
// blocker, offline, corporate proxy). Left alone it just renders nothing, so the page
// looks broken with no explanation — hence the watchdog.
const GIS_WATCHDOG_MS = 6000;

export default function Login() {
  const { config, signIn } = useAuth();
  const buttonRef = useRef(null);
  const [error, setError] = useState('');
  const [devBusy, setDevBusy] = useState(false);

  useEffect(() => {
    if (!config) return undefined;
    const clientId = config.googleClientId;
    if (!clientId) {
      setError('Sign-in is not configured on this server (no Google client id).');
      return undefined;
    }

    let done = false;
    const mount = () => {
      if (done || !window.google?.accounts?.id || !buttonRef.current) return;
      try {
        window.google.accounts.id.initialize({
          client_id: clientId,
          callback: async ({ credential }) => {
            try {
              const res = await api('/auth/google', { body: { credential } });
              signIn(res.user);
            } catch (err) {
              setError(err.message || 'Sign-in failed');
            }
          },
          // Chrome's third-party-cookie removal breaks the legacy prompt; FedCM is the
          // supported path and must stay on.
          use_fedcm_for_prompt: true,
          itp_support: true,
        });
        window.google.accounts.id.renderButton(buttonRef.current, {
          theme: 'filled_black', size: 'large', width: 300, shape: 'pill',
        });
        done = true;
      } catch (err) {
        setError(`Could not start Google sign-in: ${err.message}`);
      }
    };

    mount();
    window.addEventListener('load', mount, { once: true });
    const poll = setInterval(mount, 300);
    const watchdog = setTimeout(() => {
      if (!done) {
        setError('Google sign-in did not load. An ad blocker or network policy may be blocking accounts.google.com.');
      }
    }, GIS_WATCHDOG_MS);

    return () => {
      clearInterval(poll);
      clearTimeout(watchdog);
      window.removeEventListener('load', mount);
    };
  }, [config, signIn]);

  const devLogin = async () => {
    setDevBusy(true);
    try {
      const res = await api('/auth/dev-login', { body: {} });
      signIn(res.user);
    } catch (err) {
      setError(err.message || 'Dev login failed');
    } finally {
      setDevBusy(false);
    }
  };

  return (
    <div className="login-view">
      <div className="login-grid" aria-hidden="true" />
      <motion.div
        className="login-card"
        initial={{ opacity: 0, y: 16, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.55, ease: [0.22, 1, 0.36, 1] }}
      >
        <img className="login-logo" src="/assets/opptra-logo-white.svg" alt="Opptra" width="132" />
        <h1>Supply chain, <span>on autopilot</span></h1>
        <p>
          One workspace for every marketplace, every warehouse and every daily job —
          with an agent that can run them for you.
        </p>

        <div className="login-actions">
          <div ref={buttonRef} className="gsi-slot" />
          {config?.devLogin && (
            <Button variant="ghost" loading={devBusy} onClick={devLogin}>
              Continue as developer
            </Button>
          )}
        </div>

        {error && <p className="login-error" role="alert">{error}</p>}
        <p className="login-foot">Restricted to @opptra.com accounts.</p>
      </motion.div>
    </div>
  );
}
