import React from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import { AuthProvider } from './auth'
import './styles/base.css'
import './styles/theme-v4.css'
import './styles/landing.css'
import './styles/auth.css'
import './styles/theme-cold.css'
import './styles/premium.css'
import './styles/experience.css'

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <App />
      </AuthProvider>
    </BrowserRouter>
  </React.StrictMode>,
)
