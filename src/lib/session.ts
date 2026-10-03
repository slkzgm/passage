// Run before wallet SDK initialization: the authorization must never become
// navigation metadata sent to a wallet directory, relay or analytics service.
export const initialTransferFragment = window.location.hash
if (initialTransferFragment) window.history.replaceState(null, '', window.location.pathname + window.location.search)
