// Before anything else: consent to data processing (152-ФЗ), and a separate optional one for health data.
// Also the Profile card to change the health consent or delete the account.
import { useState } from 'react'
import { saveSnapshot } from './snapshot'
import { api, postJson, tg } from './telegram'
import { Sheet } from './ui'

export type ConsentState = { ok: boolean; health: boolean; url: string | null }

function Policy({ url }: { url: string | null }) {
  return url ? <a href={url} target="_blank" rel="noreferrer">политикой конфиденциальности</a> : <>политикой конфиденциальности</>
}

export default function Consent({ url, onDone }: { url: string | null; onDone: (health: boolean) => void }) {
  const [main, setMain] = useState(false)
  const [health, setHealth] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function go() {
    setBusy(true); setError('')
    try {
      await api('/api/consent', postJson({ health }))
      onDone(health)
    } catch {
      setError('Не получилось сохранить. Проверьте связь и попробуйте ещё раз.')
    } finally { setBusy(false) }
  }

  return (
    <main className="screen consent">
      <h1 className="home-title">Перед началом</h1>
      <p className="sub">Setly хранит анкету, дневник питания, воду, тренировки и замеры, чтобы считать вашу норму и напоминать о важном. Данные не продаём и не передаём рекламным сетям.</p>
      <section className="card">
        <label className="consent-check">
          <input type="checkbox" checked={main} onChange={(e) => setMain(e.target.checked)} />
          <span><b>Согласен на обработку персональных данных</b><span className="sub">Анкета, дневник, вода, тренировки, замеры — в соответствии с <Policy url={url} />. Фото еды уходят на распознавание и не сохраняются.</span></span>
        </label>
        <label className="consent-check">
          <input type="checkbox" checked={health} onChange={(e) => setHealth(e.target.checked)} />
          <span><b>Учитывать здоровье — по желанию</b><span className="sub">Аллергии и травмы, чтобы не советовать лишнего. Без этой галочки таких вопросов в анкете не будет. Можно поменять в профиле.</span></span>
        </label>
      </section>
      {error && <p className="error" role="alert">{error}</p>}
      <button className="btn" disabled={!main || busy} onClick={go}>{busy ? 'Сохраняем…' : 'Продолжить'}</button>
      <p className="sub">Удалить аккаунт и все данные можно в любой момент: Профиль → «Удалить аккаунт» или команда /delete в боте.</p>
    </main>
  )
}

/** Profile: health consent switch and account deletion. */
export function PrivacyCard({ consent, onHealth }: { consent: ConsentState; onHealth: (health: boolean) => void }) {
  const [ask, setAsk] = useState(false)
  const [state, setState] = useState<'idle' | 'busy' | 'done' | 'error'>('idle')

  async function toggleHealth() {
    const next = !consent.health
    try { await api('/api/consent', postJson({ health: next })); onHealth(next) } catch { /* the switch stays as it was */ }
  }

  async function remove() {
    setState('busy')
    try {
      await api('/api/account', { method: 'DELETE' })
      saveSnapshot(null) // nothing of the old account stays on the phone
      setState('done')
      setTimeout(() => tg?.close?.(), 2500)
    } catch { setState('error') }
  }

  return (
    <section className="card">
      <h2>Данные и конфиденциальность</h2>
      <label className="consent-check">
        <input type="checkbox" checked={consent.health} onChange={toggleHealth} />
        <span><b>Учитывать аллергии и травмы</b><span className="sub">{consent.health ? 'Если выключить, эти ответы сотрутся из анкеты.' : 'Включите, чтобы указать их в анкете.'}</span></span>
      </label>
      {consent.url && <a className="link" href={consent.url} target="_blank" rel="noreferrer">Политика конфиденциальности</a>}
      <button className="link danger" onClick={() => setAsk(true)}>Удалить аккаунт и все данные</button>
      {ask && (
        <Sheet title="Удалить аккаунт?" onClose={() => state !== 'busy' && setAsk(false)}>
          {state === 'done' ? <p>Готово: аккаунт и данные удалены. Если вернётесь — начнём с чистого листа.</p> : <>
            <p className="sub">Удалятся анкета, дневник, тренировки, замеры, привычки, друзья и XP. Это нельзя отменить. Из резервных копий данные исчезнут в течение 14 дней.</p>
            {state === 'error' && <p className="error" role="alert">Не получилось удалить. Попробуйте ещё раз.</p>}
            <button className="btn btn-danger" disabled={state === 'busy'} onClick={remove}>{state === 'busy' ? 'Удаляем…' : 'Удалить навсегда'}</button>
            <button className="btn btn-ghost" onClick={() => setAsk(false)}>Отмена</button>
          </>}
        </Sheet>
      )}
    </section>
  )
}
