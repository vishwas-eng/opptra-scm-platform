import { motion } from 'framer-motion';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, KeyValues } from '../../components/ui.jsx';
import { api } from '../../lib/api.js';
import { fmtRelative } from '../../lib/format.js';
import { useToast } from '../../lib/toast.jsx';
import { ConnectorIcon } from '../Connectors.jsx';
import ResourceBindings from './ResourceBindings.jsx';
import AmazonConnect from './AmazonConnect.jsx';
import CaptureGuide from './CaptureGuide.jsx';

const GOOGLE_OAUTH = '/auth/google/connect?return=connectors';

// Three different endpoints all answer "your Google grant is stale" in prose. Rather
// than three regexes scattered through the file, one predicate decides when the only
// useful response is to send the user back through consent.
function needsGoogleConsent(message) {
  return /oauth|google account|reconnect|missing google/i.test(String(message || ''));
}

export default function ConnectorDetail({ connector: c, onClose, onChanged }) {
  const { ok, bad } = useToast();
  const [busy, setBusy] = useState(false);

  const act = async (action) => {
    setBusy(true);
    try {
      await api(`/api/agent/connectors/${c.id}/${action}`, { body: {} });
      ok(action === 'connect' ? `${c.name} connected.` : `${c.name} disconnected.`);
      onChanged();
    } catch (err) {
      if (needsGoogleConsent(err.message)) {
        window.location.href = GOOGLE_OAUTH;
        return;
      }
      bad(err.message);
    } finally {
      setBusy(false);
    }
  };

  const capture = c.detail?.capture;

  return (
    <motion.aside
      className="conn-detail"
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 12 }}
      transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
    >
      <header className="conn-detail-head">
        <ConnectorIcon connector={c} size={32} />
        <div>
          <h3>{c.name}</h3>
          <p className="meta">{c.connectHint || c.blurb}</p>
        </div>
        <button type="button" className="conn-close" onClick={onClose} aria-label="Close">×</button>
      </header>

      <div className="conn-detail-body">
        {/* --- live connectors: connect / disconnect / bind --- */}
        {c.live && (
          <>
            {c.scope === 'platform' ? (
              // The company's own credential. Everyone shares it; nobody toggles it.
              <div className="conn-platform">
                <p className="lead">
                  {c.systemReady
                    ? 'Configured by the platform and shared by everyone — nothing for you to connect.'
                    : 'Not configured yet. An admin sets this up once for the whole team.'}
                </p>
                {c.id === 'unicommerce' && !c.systemReady && (
                  <Link className="btn btn-primary" to="/schedules">Connect Unicommerce</Link>
                )}
              </div>
            ) : c.connectMode === 'google-user' ? (
              c.connected ? (
                <div className="conn-actions">
                  <Button loading={busy} onClick={() => act('disconnect')}>Disconnect</Button>
                  <a className="btn btn-ghost" href={GOOGLE_OAUTH}>Re-authorize Google</a>
                </div>
              ) : (
                <a className="btn btn-primary" href={c.oauthUrl || GOOGLE_OAUTH}>Connect Google</a>
              )
            ) : c.connected ? (
              <div className="conn-actions">
                <Button loading={busy} onClick={() => act('disconnect')}>Disconnect</Button>
              </div>
            ) : c.systemReady ? (
              <Button variant="primary" loading={busy} onClick={() => act('connect')}>Connect</Button>
            ) : (
              <p className="meta">{c.connectHint}</p>
            )}

            <ResourceBindings connector={c} onChanged={onChanged} />
          </>
        )}

        {/* --- not live yet: the real paths forward, per channel --- */}
        {!c.live && c.connectMode === 'oauth-amazon' && <AmazonConnect />}
        {!c.live && c.connectMode === 'capture' && <CaptureGuide connector={c} />}
        {!c.live && c.connectMode === 'official-api' && (
          <p className="lead">
            This channel publishes a real seller API — we build against that rather than
            recording a login. Needs API credentials from their onboarding team.
          </p>
        )}
        {!c.live && c.connectMode === 'via-noon' && (
          <p className="lead">
            Runs on the same platform as noon — one connection serves both marketplaces,
            so connect noon and this comes with it.
          </p>
        )}
        {!c.live && c.connectMode === 'partner' && (
          <p className="lead">
            Access is granted per integrator: they whitelist our vendor ID rather than
            issuing a key. Ask the category/account manager to enable it.
          </p>
        )}
        {!c.live && c.connectMode === 'email-po' && (
          <p className="lead">
            No vendor API exists. Purchase orders arrive by email as PDF/XLSX — the
            connector parses the mailbox, and Unicommerce already ingests this channel
            too. The work worth doing here is appointments, GRN reconciliation and
            fill-rate, not fetching the PO.
          </p>
        )}

        {capture && (
          <div className="capture-summary">
            <h4>Latest capture</h4>
            <KeyValues pairs={[
              ['Endpoints found', capture.endpoints ?? '—'],
              ['Requests recorded', capture.entries ?? '—'],
              ['API host', capture.primaryHost || '—'],
              ['Session captured', capture.sessionSaved ? 'yes' : 'no'],
              ['When', fmtRelative(capture.capturedAt)],
            ]}
            />
          </div>
        )}
      </div>
    </motion.aside>
  );
}
