import { Navigate, Outlet } from 'react-router';

import { useSession } from './session-context';

export function RequireProduction(): React.JSX.Element {
  const { state, loading, error } = useSession();

  if (loading && state === null) {
    return <div className="route-state">Carregando permissões…</div>;
  }

  if (error !== null) {
    return <div className="route-state route-state--error">{error}</div>;
  }

  if (state?.profile !== 'production') {
    return <Navigate replace to="/mesas" />;
  }

  return <Outlet />;
}
