import './lib/session'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { WalletRoot } from './components/WalletRoot'
import './styles.css'

createRoot(document.getElementById('root')!).render(<StrictMode><WalletRoot><App /></WalletRoot></StrictMode>)
