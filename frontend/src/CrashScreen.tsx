// When something in the Mini App breaks: report it and show a way out, not a blank screen.
import { Component, type ReactNode } from 'react'
import { reportCrash } from './crash'

export default class CrashScreen extends Component<{ children: ReactNode }, { broken: boolean }> {
  state = { broken: false }

  static getDerivedStateFromError() { return { broken: true } }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    reportCrash(error.message, `${error.stack ?? ''}\n${info.componentStack ?? ''}`, 'экран')
  }

  render() {
    if (!this.state.broken) return this.props.children
    return (
      <div className="crash">
        <div className="crash-icon" aria-hidden="true">🛠</div>
        <h1>Что-то сломалось</h1>
        <p className="sub">Мы уже получили сообщение об ошибке. Ваши записи сохранены — попробуйте открыть приложение заново.</p>
        <button className="btn" onClick={() => location.reload()}>Перезапустить</button>
      </div>
    )
  }
}
