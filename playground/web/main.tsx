import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App, Checkout } from './App.tsx';
import './styles.css';

// The dev sandbox's mock checkout lives at /checkout/<customer id> (WP-51); everything else is the app.
const checkout = window.location.pathname.match(/^\/checkout\/([\w-]+)$/);

createRoot(document.getElementById('root')!).render(
  <StrictMode>{checkout ? <Checkout customerId={checkout[1]!} /> : <App />}</StrictMode>,
);
