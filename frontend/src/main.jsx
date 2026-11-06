import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

// The login screen renders before the dashboard (which owns the theme toggle) mounts.
document.documentElement.className = localStorage.getItem('transcriber_theme') || 'dark'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
