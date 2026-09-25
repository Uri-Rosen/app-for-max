import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/assistant';
import '@fontsource/frank-ruhl-libre/400.css';
import '@fontsource/frank-ruhl-libre/500.css';
import '@fontsource/frank-ruhl-libre/700.css';
import './styles.css';
import App from './App.tsx';

try {
  const t = localStorage.getItem('theme');
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
} catch {
  // storage unavailable: follow the system theme
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
