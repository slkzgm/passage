// Applies the saved theme before first paint to avoid a flash. A separate file because the CSP blocks inline scripts.
// Keep the key in sync with src/lib/theme.ts.
try {
  var theme = localStorage.getItem('passage-theme')
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme
} catch (error) { /* Storage unavailable: follow the system theme. */ }
