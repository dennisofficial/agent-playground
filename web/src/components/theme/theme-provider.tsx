'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

export const THEMES = ['daylight', 'terminal', 'warm'] as const;
export type Theme = (typeof THEMES)[number];

export const THEME_LABELS: Record<Theme, string> = {
  daylight: 'Day',
  terminal: 'Terminal',
  warm: 'Warm',
};

const STORAGE_KEY = 'atlas-theme';
const DEFAULT_THEME: Theme = 'daylight';

interface ThemeContextValue {
  theme: Theme;
  setTheme: (theme: Theme) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function readTheme(): Theme {
  if (typeof document !== 'undefined') {
    const attr = document.documentElement.getAttribute('data-theme');
    if (attr && (THEMES as readonly string[]).includes(attr)) return attr as Theme;
  }
  return DEFAULT_THEME;
}

/**
 * Theme context. The actual `data-theme` attribute is set pre-paint by the inline script in the root
 * layout (no flash); this provider just reflects + mutates it and persists to localStorage. Every
 * color is a CSS variable, so the swap is free (no re-render of styles).
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  // Initialize from the attribute the no-flash script already set (avoids a hydration mismatch).
  const [theme, setThemeState] = useState<Theme>(DEFAULT_THEME);

  useEffect(() => {
    setThemeState(readTheme());
  }, []);

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next);
    document.documentElement.setAttribute('data-theme', next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* ignore */
    }
  }, []);

  const value = useMemo(() => ({ theme, setTheme }), [theme, setTheme]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within <ThemeProvider>');
  return ctx;
}
