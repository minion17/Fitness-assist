// Morning check-in on Home: how they slept and how much energy there is. After a few weeks the server finds a pattern
// ("в дни после сна 7+ часов ты съедаешь на 300 ккал меньше") and the card shows it once answered.
import { useEffect, useState } from 'react'
import { haptic } from './haptics'
import { api, postJson } from './telegram'

type State = { sleep: number | null; energy: number | null; insight: string | null }
const SLEEP: [string, number][] = [['<6 ч', 1], ['6–7', 2], ['7–8', 3], ['8+', 4]]
const ENERGY: [string, number][] = [['😩 мало сил', 1], ['🙂 норм', 2], ['💪 бодро', 3]]

export default function Checkin() {
  const [hour] = useState(() => new Date().getHours())
  const [s, setS] = useState<State | null>(null)
  const [closed, setClosed] = useState(false)
  const morning = hour >= 5 && hour < 12
  useEffect(() => {
    if (morning) api<State>('/api/checkin').then((r) => r && setS(r)).catch(() => {})
  }, [morning])
  if (!morning || !s || closed || (s.sleep && s.energy && !s.insight)) return null

  const send = (body: Partial<State>) => {
    haptic('select')
    setS({ ...s, ...body })
    api<State>('/api/checkin', postJson(body)).then((r) => r && setS(r)).catch(() => {})
  }
  return (
    <section className="card checkin" aria-label="Утренний вопрос">
      {!s.sleep ? <>
        <h2>☀️ Как спалось?</h2>
        <div className="checkin-row">{SLEEP.map(([t, v]) => <button key={v} className="chip" onClick={() => send({ sleep: v })}>{t}</button>)}</div>
      </> : !s.energy ? <>
        <h2>А как энергия?</h2>
        <div className="checkin-row">{ENERGY.map(([t, v]) => <button key={v} className="chip" onClick={() => send({ energy: v })}>{t}</button>)}</div>
      </> : <>
        <div className="card-head"><h2>💡 Наблюдение</h2><button className="link" aria-label="Скрыть" onClick={() => setClosed(true)}>✕</button></div>
        <p>{s.insight}</p>
      </>}
    </section>
  )
}
