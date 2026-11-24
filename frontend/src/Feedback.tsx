// Profile: write to the team (an idea or a bug) — straight to the developers' chat. Also used from a product
// ("Неверные КБЖУ?"), so wrong numbers get fixed instead of staying in the base for everyone.
import { useState } from 'react'
import { api, ApiError, postJson } from './telegram'

type Kind = 'idea' | 'bug' | 'product'

export function FeedbackForm({ kind: fixed, productId, placeholder, onSent }: { kind?: Kind; productId?: number; placeholder?: string; onSent?: () => void }) {
  const [kind, setKind] = useState<Kind>(fixed ?? 'idea')
  const [text, setText] = useState('')
  const [state, setState] = useState<'idle' | 'busy' | 'sent'>('idle')
  const [error, setError] = useState('')

  async function send() {
    if (text.trim().length < 3) return setError('Напиши хотя бы пару слов')
    setState('busy'); setError('')
    try {
      await api('/api/feedback', postJson({ kind, text: text.trim(), product_id: productId ?? null }))
      setState('sent'); setText(''); onSent?.()
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Не отправилось. Проверь интернет'); setState('idle')
    }
  }

  if (state === 'sent') return <p className="sub pos" role="status">Спасибо, получили. Если нужно, ответим в чате.</p>
  return (
    <div className="feedback-form">
      {!fixed && (
        <div className="habit-chips" role="group" aria-label="О чём">
          <button type="button" className="habit-chip" aria-pressed={kind === 'idea'} onClick={() => setKind('idea')}>💡 Идея</button>
          <button type="button" className="habit-chip" aria-pressed={kind === 'bug'} onClick={() => setKind('bug')}>🐞 Что-то не работает</button>
        </div>
      )}
      <textarea aria-label="Сообщение" rows={3} maxLength={2000} value={text} placeholder={placeholder ?? (kind === 'bug' ? 'Что случилось и где?' : 'Чего не хватает? Что сделать удобнее?')}
        onChange={(e) => { setText(e.target.value); setError('') }} />
      {error && <p className="error" role="alert">{error}</p>}
      <button className="btn btn-ghost" disabled={state === 'busy'} onClick={send}>{state === 'busy' ? 'Отправляем…' : 'Отправить'}</button>
    </div>
  )
}

export default function FeedbackCard() {
  return (
    <section className="card">
      <h2>Написать команде</h2>
      <p className="sub">Идеи и ошибки читаем сами, без ботов-автоответчиков. Самое частое делаем первым.</p>
      <FeedbackForm />
    </section>
  )
}
