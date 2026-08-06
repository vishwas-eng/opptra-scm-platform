import { useEffect, useState } from 'react';
import { Badge, Button, Skeleton } from '../../components/ui.jsx';
import { api } from '../../lib/api.js';
import { fmtRelative } from '../../lib/format.js';

const MARKETS = [
  { id: 'in', label: 'India', host: 'amazon.in' },
  { id: 'ae', label: 'UAE', host: 'amazon.ae' },
  { id: 'sa', label: 'KSA', host: 'amazon.sa' },
];

/**
 * Amazon is the one channel with a real seller grant: the operator authorizes once per
 * marketplace in Seller Central and we hold that region's refresh token forever after.
 * No cookies, no capture, nothing that could look like scraping.
 */
export default function AmazonConnect() {
  const [status, setStatus] = useState(null);

  useEffect(() => {
    api('/api/admin/amazon/status').then(setStatus).catch(() => setStatus({ error: true }));
  }, []);

  if (!status) return <Skeleton h={90} />;

  if (status.error) {
    return <p className="meta">Could not read Amazon status.</p>;
  }

  return (
    <div className="amazon-connect">
      <p className="lead">
        Authorize once per marketplace in Amazon&apos;s own Seller Central. We never see
        the password, and the grant survives password changes.
      </p>

      {!status.appConfigured && (
        <div className="conn-warn">
          The SP-API application is not configured on this server yet. An admin needs to
          create the app in <strong>Seller Central → Develop Apps</strong> and set
          <code>AMAZON_APP_ID</code>, <code>AMAZON_SP_CLIENT_ID</code> and
          <code>AMAZON_SP_CLIENT_SECRET</code>.
        </div>
      )}

      <div className="market-list">
        {MARKETS.map((m) => {
          const s = status.marketplaces?.[m.id] || {};
          return (
            <div key={m.id} className="market-row">
              <div className="market-name">
                <strong>{m.label}</strong>
                <span className="meta">{m.host}</span>
              </div>
              {s.connected ? (
                <>
                  <Badge tone="ok">Connected</Badge>
                  <span className="meta">
                    {s.sellingPartnerId ? `${s.sellingPartnerId} · ` : ''}{fmtRelative(s.updatedAt)}
                  </span>
                  <a className="btn btn-ghost btn-sm" href={`/auth/amazon/connect?marketplace=${m.id}`}>
                    Re-authorize
                  </a>
                </>
              ) : (
                <>
                  <Badge tone="neutral">Not connected</Badge>
                  <a
                    className={`btn btn-sm ${status.appConfigured ? 'btn-primary' : 'btn-secondary'}`}
                    href={`/auth/amazon/connect?marketplace=${m.id}`}
                    aria-disabled={!status.appConfigured}
                    onClick={(e) => { if (!status.appConfigured) e.preventDefault(); }}
                  >
                    Connect
                  </a>
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export { Button };
