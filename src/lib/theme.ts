export type Theme = 'light' | 'dark'

// Keep in sync with public/theme-init.js, which applies the stored choice before first paint.
const storageKey = 'passage-theme'
const backgrounds: Record<Theme, string> = { light: '#f4f4f5', dark: '#09090b' }
const systemDark = window.matchMedia('(prefers-color-scheme: dark)')
const listeners = new Set<() => void>()

let override: Theme | null = null
try {
  const stored = localStorage.getItem(storageKey)
  if (stored === 'light' || stored === 'dark') override = stored
} catch { /* Storage can be unavailable; the theme then follows the system. */ }

const systemTheme = (): Theme => (systemDark.matches ? 'dark' : 'light')
export const currentTheme = (): Theme => override ?? systemTheme()

function apply() {
  const root = document.documentElement
  if (override) root.dataset.theme = override
  else delete root.dataset.theme
  // Media-scoped theme-color tags only follow the system, so pin them to an explicit choice.
  document.querySelectorAll('meta[name="theme-color"]').forEach(meta => {
    meta.setAttribute('content', backgrounds[override ?? (meta.getAttribute('media')?.includes('dark') ? 'dark' : 'light')])
  })
  listeners.forEach(listener => listener())
}

export function setTheme(theme: Theme) {
  // Choosing the system theme clears the override so later system changes are followed again.
  override = theme === systemTheme() ? null : theme
  try {
    if (override) localStorage.setItem(storageKey, override)
    else localStorage.removeItem(storageKey)
  } catch { /* The choice then lasts for this page only. */ }
  apply()
}

export function subscribeTheme(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

systemDark.addEventListener('change', apply)
apply()
