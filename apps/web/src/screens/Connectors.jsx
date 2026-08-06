import { AnimatePresence, motion } from 'framer-motion';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { PageTransition, StatusPill } from '../components/ui.jsx';
import { api } from '../lib/api.js';
import { useToast } from '../lib/toast.jsx';
import ConnectorDetail from './connectors/ConnectorDetail.jsx';
import './connectors.css';

const PILL_LABEL = {
  connected: 'On',
  ready: 'Ready',
  needs_reconnect: 'Reconnect',
  blueprint_ready: 'Mapped',
  coming_soon: 'Soon',
  disconnected: 'Off',
};

export function ConnectorIcon({ connector, size = 20 }) {
  const [broken, setBroken] = useState(false);
  if (broken) {
    return <div className="conn-icon conn-icon-fallback" style={{ '--icon-size': `${size}px` }}>{connector.icon}</div>;
  }
  return (
    <div className="conn-icon" style={{ '--icon-size': `${size}px` }}>
      <img
        src={`/assets/connectors/${connector.id}.svg`}
        alt=""
        width={size}
        height={size}
        decoding="async"
        onError={() => setBroken(true)}
      />
    </div>
  );
}

function ConnectorCard({ connector, onOpen, index }) {
  return (
    <motion.button
      type="button"
      className={`conn-card${connector.live ? '' : ' conn-soon'}`}
      onClick={() => onOpen(connector.id)}
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: Math.min(index * 0.025, 0.3), duration: 0.32, ease: [0.22, 1, 0.36, 1] }}
      whileHover={{ y: -2 }}
    >
      <ConnectorIcon connector={connector} />
      <span className="conn-name">{connector.name}</span>
      <span className="conn-blurb">{connector.connectHint || connector.blurb}</span>
      <StatusPill status={connector.status}>{PILL_LABEL[connector.status] || 'Off'}</StatusPill>
    </motion.button>
  );
}

export default function Connectors() {
  const { bad } = useToast();
  const [connectors, setConnectors] = useState([]);
  const [openId, setOpenId] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const r = await api('/api/agent/connectors');
      setConnectors(r.connectors || []);
    } catch (err) {
      bad(err.message);
    } finally {
      setLoading(false);
    }
  }, [bad]);

  useEffect(() => { load(); }, [load]);

  const live = connectors.filter((c) => c.live);
  const soon = connectors.filter((c) => !c.live);
  const open = connectors.find((c) => c.id === openId) || null;

  return (
    <PageTransition>
      <div className="conn-page-head">
        <p className="lead">
          Everything the platform can reach. Connected sources power the automations,
          the <Link to="/agent">Agent</Link>, and any MCP client you have paired.
        </p>
      </div>

      <section className="conn-section">
        <h4 className="conn-section-title">Connected sources</h4>
        <div className="conn-grid">
          {live.map((c, i) => <ConnectorCard key={c.id} connector={c} onOpen={setOpenId} index={i} />)}
          {loading && !live.length && <div className="meta">Loading…</div>}
        </div>
      </section>

      <section className="conn-section">
        <h4 className="conn-section-title">Channels being brought online</h4>
        <div className="conn-grid">
          {soon.map((c, i) => <ConnectorCard key={c.id} connector={c} onOpen={setOpenId} index={i} />)}
        </div>
      </section>

      <AnimatePresence>
        {open && (
          <ConnectorDetail
            connector={open}
            onClose={() => setOpenId(null)}
            onChanged={load}
          />
        )}
      </AnimatePresence>
    </PageTransition>
  );
}
