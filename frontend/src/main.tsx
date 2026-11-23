// fonts ship with the app: Google Fonts is slow or blocked for part of the audience
import '@fontsource-variable/onest'
import '@fontsource-variable/nunito'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import CrashScreen from './CrashScreen'
import { watchCrashes } from './crash'

watchCrashes()

// opens without a connection next time: the page and its files are kept on the phone (public/sw.js)
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').catch(() => {}) })
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <CrashScreen>
      <App />
    </CrashScreen>
  </StrictMode>,
)
