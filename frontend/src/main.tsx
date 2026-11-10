// fonts ship with the app: Google Fonts is slow or blocked for part of the audience
import '@fontsource-variable/manrope'
import '@fontsource-variable/unbounded'
import '@fontsource-variable/nunito'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import CrashScreen from './CrashScreen'
import { watchCrashes } from './crash'

watchCrashes()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <CrashScreen>
      <App />
    </CrashScreen>
  </StrictMode>,
)
