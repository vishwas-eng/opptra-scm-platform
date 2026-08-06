import { lazy, Suspense, useEffect } from 'react';
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import Shell, { useRegion } from './components/Shell.jsx';
import { Spinner } from './components/ui.jsx';
import { useAuth } from './lib/auth.jsx';
import { useToast } from './lib/toast.jsx';
import Login from './screens/Login.jsx';
import Dashboard from './screens/Dashboard.jsx';

// Everything except the workspace is code-split: the dashboard is what loads on sign-in,
// and no operator should pay to download the admin console to look at it.
const Agent = lazy(() => import('./screens/Agent.jsx'));
const Connectors = lazy(() => import('./screens/Connectors.jsx'));
const Asn = lazy(() => import('./screens/Asn.jsx'));
const ReverseDc = lazy(() => import('./screens/ReverseDc.jsx'));
const Packing = lazy(() => import('./screens/Packing.jsx'));
const SheetUpdate = lazy(() => import('./screens/SheetUpdate.jsx'));
const EwayBill = lazy(() => import('./screens/EwayBill.jsx'));
const HomeCentre = lazy(() => import('./screens/HomeCentre.jsx'));
const Channels = lazy(() => import('./screens/Channels.jsx'));
const Returns = lazy(() => import('./screens/Returns.jsx'));
const Inventory = lazy(() => import('./screens/Inventory.jsx'));
const Schedules = lazy(() => import('./screens/Schedules.jsx'));
const Extensions = lazy(() => import('./screens/Extensions.jsx'));
const Admin = lazy(() => import('./screens/Admin.jsx'));

/** Admin-only route. The server enforces this too; this only avoids a dead screen. */
function AdminRoute({ children }) {
  const { isAdmin } = useAuth();
  const { bad } = useToast();
  const navigate = useNavigate();
  useEffect(() => {
    if (!isAdmin) {
      bad('That section is admin-only.');
      navigate('/', { replace: true });
    }
  }, [isAdmin, bad, navigate]);
  return isAdmin ? children : null;
}

/** Surface the result of a Google/Amazon OAuth round-trip, then clean the URL. */
function useOAuthReturn() {
  const { toast, ok, bad } = useToast();
  const location = useLocation();
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    const google = q.get('googleConnect');
    const amazon = q.get('amazonConnect');
    if (!google && !amazon) return;

    if (google === 'ok') {
      const mismatch = q.get('googleMismatch');
      if (mismatch) bad(`Connected as ${q.get('googleAccount') || 'another account'} — that differs from your login.`);
      else ok('Google connected.');
    } else if (google) {
      bad(`Google connect failed: ${google}`);
    }

    if (amazon === 'ok') ok(`Amazon ${(q.get('marketplace') || '').toUpperCase()} connected.`);
    else if (amazon) bad(`Amazon connect failed: ${amazon}`);

    window.history.replaceState({}, '', location.pathname);
  }, [location.search, location.pathname, toast, ok, bad]);
}

function Loading() {
  return <div className="route-loading"><Spinner /></div>;
}

export default function App() {
  const { user, booting } = useAuth();
  const [region, setRegion] = useRegion();
  useOAuthReturn();

  if (booting) return <div className="route-loading boot"><Spinner label="Starting" /></div>;
  if (!user) return <Login />;

  return (
    <Shell region={region} setRegion={setRegion}>
      <Suspense fallback={<Loading />}>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/agent" element={<AdminRoute><Agent /></AdminRoute>} />
          <Route path="/connectors" element={<AdminRoute><Connectors /></AdminRoute>} />
          <Route path="/asn" element={<Asn />} />
          <Route path="/reverse-dc" element={<ReverseDc />} />
          <Route path="/packing" element={<Packing />} />
          <Route path="/sheet" element={<SheetUpdate />} />
          <Route path="/eway-bill" element={<EwayBill />} />
          <Route path="/home-centre" element={<HomeCentre />} />
          <Route path="/channels" element={<Channels />} />
          <Route path="/returns" element={<Returns />} />
          <Route path="/inventory" element={<Inventory />} />
          <Route path="/schedules" element={<Schedules />} />
          <Route path="/extensions" element={<Extensions />} />
          <Route path="/admin" element={<AdminRoute><Admin /></AdminRoute>} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </Shell>
  );
}
