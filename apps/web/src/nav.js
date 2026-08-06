// One source of truth for navigation: the router, the sidebar and the page title all
// read this, so a new screen can never appear in one and be missing from another.

export const NAV = [
  { path: '/', id: 'dashboard', label: 'Workspace', icon: '▪', title: 'Workspace' },

  { group: 'Agents' },
  { path: '/agent', id: 'agent', label: 'Agent', icon: '✦', title: 'Agent', admin: true, pill: 'Beta' },
  { path: '/connectors', id: 'connectors', label: 'Connectors', icon: '⬡', title: 'Connectors', admin: true },

  { group: 'Automations' },
  { path: '/asn', id: 'asn', label: 'ASN Compile', icon: '▤', title: 'ASN / Packaging Compile' },
  { path: '/reverse-dc', id: 'reversedc', label: 'Reverse DC', icon: '⤺', title: 'Reverse Delivery Challan' },
  { path: '/packing', id: 'packing', label: 'Packing Mail', icon: '✉', title: 'Packing Mail' },
  { path: '/sheet', id: 'sheet', label: 'Sheet Update', icon: '▦', title: 'Sheet Update' },
  { path: '/eway-bill', id: 'ewaybill', label: 'E-way Bill', icon: '▤', title: 'E-way Bill Generation' },
  { path: '/home-centre', id: 'homecentre', label: 'Home Centre Sync', icon: '⇄', title: 'Home Centre Sync', region: 'gcc' },
  { path: '/returns', id: 'return', label: 'Return Flow', icon: '↺', title: 'Return + Re-dispatch' },
  { path: '/inventory', id: 'inventory', label: 'Inward / Outward', icon: '⇅', title: 'Inward / Outward / Full-cycle' },
  { path: '/schedules', id: 'schedules', label: 'Scheduled Jobs', icon: '⏱', title: 'Scheduled Jobs' },

  { group: 'Tools' },
  { path: '/extensions', id: 'extensions', label: 'Extensions', icon: '⤓', title: 'Browser Extensions' },
  { path: '/admin', id: 'admin', label: 'Admin', icon: '⚙', title: 'Admin', admin: true },
];

export const NAV_ITEMS = NAV.filter((n) => n.path);

export function titleForPath(pathname) {
  const exact = NAV_ITEMS.find((n) => n.path === pathname);
  if (exact) return exact.title;
  const prefix = NAV_ITEMS.filter((n) => n.path !== '/').find((n) => pathname.startsWith(n.path));
  return prefix?.title || 'Opptra SCM';
}

/** Nav entries this user should see, given role and selected region. */
export function visibleNav({ isAdmin, region }) {
  const out = [];
  for (const entry of NAV) {
    if (entry.group) { out.push(entry); continue; }
    if (entry.admin && !isAdmin) continue;
    if (entry.region && entry.region !== region) continue;
    out.push(entry);
  }
  // Drop a group header whose whole section got filtered away.
  return out.filter((entry, i) => {
    if (!entry.group) return true;
    const next = out[i + 1];
    return next && !next.group;
  });
}
