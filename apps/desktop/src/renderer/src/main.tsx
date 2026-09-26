import '@fontsource-variable/inter';
import './styles/global.css';

import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router';

import { router } from './app/router';
import { SessionProvider } from './shared/session/SessionProvider';

const rootElement = document.getElementById('root');

if (rootElement === null) {
  throw new Error('Contêiner principal do GTRZ System não foi encontrado.');
}

createRoot(rootElement).render(
  <SessionProvider>
    <RouterProvider router={router} useTransitions={false} />
  </SessionProvider>,
);
