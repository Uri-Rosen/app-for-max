import { useEffect, useState } from 'react';

// Hash routing: the app is served from one local page and works offline.

export function currentPath(): string {
  const h = window.location.hash.replace(/^#/, '');
  return h || '/today';
}

export function useRoute(): { path: string; parts: string[]; query: URLSearchParams } {
  const [path, setPath] = useState(currentPath());
  useEffect(() => {
    const on = () => setPath(currentPath());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  const [p, q = ''] = path.split('?');
  return { path: p, parts: p.split('/').filter(Boolean), query: new URLSearchParams(q) };
}

export function go(path: string): void {
  window.location.hash = path;
}

export function Link(props: { to: string; className?: string; children: React.ReactNode; title?: string }) {
  return (
    <a href={`#${props.to}`} className={props.className} title={props.title}>
      {props.children}
    </a>
  );
}
