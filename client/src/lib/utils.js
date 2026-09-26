import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs) {
  return twMerge(clsx(inputs));
}

export function parseYouTubeId(input) {
  if (!input) return null;
  input = input.trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(input)) return input;
  try {
    const u = new URL(input);
    const host = u.hostname.replace(/^www\.|^m\.|^music\./, '');
    if (host === 'youtu.be') {
      const id = u.pathname.slice(1).split(/[?/]/)[0];
      if (/^[A-Za-z0-9_-]{11}$/.test(id)) return id;
    }
    if (host.endsWith('youtube.com') || host.endsWith('youtube-nocookie.com')) {
      const v = u.searchParams.get('v');
      if (v && /^[A-Za-z0-9_-]{11}$/.test(v)) return v;
      const pm = u.pathname.match(/\/(embed|shorts|live|v)\/([A-Za-z0-9_-]{11})/);
      if (pm) return pm[2];
    }
  } catch {}
  const m = input.match(/([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}
