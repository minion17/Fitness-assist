// Profile: timezone for the diary's "today" and reminder times. By default it follows the phone (handy when travelling).
import { useEffect, useState } from 'react'
import { api, deviceTz, putJson } from './telegram'

const ZONES: [string, string][] = [
  ['Europe/Kaliningrad', 'Калининград'], ['Europe/Moscow', 'Москва'], ['Europe/Samara', 'Самара'],
  ['Asia/Yekaterinburg', 'Екатеринбург'], ['Asia/Omsk', 'Омск'], ['Asia/Novosibirsk', 'Новосибирск'],
  ['Asia/Krasnoyarsk', 'Красноярск'], ['Asia/Irkutsk', 'Иркутск'], ['Asia/Yakutsk', 'Якутск'],
  ['Asia/Vladivostok', 'Владивосток'], ['Asia/Magadan', 'Магадан'], ['Asia/Kamchatka', 'Камчатка'],
  ['Europe/Minsk', 'Минск'], ['Europe/Kyiv', 'Киев'], ['Europe/Chisinau', 'Кишинёв'], ['Asia/Tbilisi', 'Тбилиси'],
  ['Asia/Yerevan', 'Ереван'], ['Asia/Baku', 'Баку'], ['Asia/Almaty', 'Алматы'], ['Asia/Tashkent', 'Ташкент'],
  ['Asia/Bishkek', 'Бишкек'], ['Asia/Dushanbe', 'Душанбе'], ['Asia/Ashgabat', 'Ашхабад'],
  ['Europe/Istanbul', 'Стамбул'], ['Asia/Dubai', 'Дубай'], ['Asia/Bangkok', 'Бангкок'], ['Asia/Makassar', 'Бали'],
  ['Europe/Berlin', 'Берлин'], ['Europe/London', 'Лондон'], ['America/New_York', 'Нью-Йорк'],
]

/** "UTC+5" for a zone right now. */
function offset(zone: string): string {
  try {
    const part = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'shortOffset' })
      .formatToParts(new Date()).find((p) => p.type === 'timeZoneName')?.value ?? ''
    return part.replace('GMT', 'UTC') === 'UTC' ? 'UTC+0' : part.replace('GMT', 'UTC')
  } catch { return '' }
}
const label = (zone: string) => `${ZONES.find(([z]) => z === zone)?.[1] ?? zone.split('/').pop()!.replace(/_/g, ' ')}, ${offset(zone)}`

export default function Timezone() {
  const [zone, setZone] = useState<string | null | undefined>(undefined) // undefined: loading, null: follow the phone
  const [error, setError] = useState('')
  const phone = deviceTz()

  useEffect(() => {
    api<{ timezone: string | null }>('/api/settings').then((s) => setZone(s?.timezone ?? null)).catch(() => setZone(null))
  }, [])

  function choose(value: string) {
    const next = value || null
    setZone(next)
    setError('')
    api('/api/settings', putJson({ timezone: next ?? '' })).catch(() => setError('Не удалось сохранить. Проверьте соединение.'))
  }

  if (zone === undefined) return null
  const options = zone && !ZONES.some(([z]) => z === zone) ? [...ZONES, [zone, zone] as [string, string]] : ZONES
  return (
    <section className="card">
      <h2>Часовой пояс</h2>
      <p className="sub">По нему начинается новый день в дневнике и приходят напоминания.</p>
      <select className="select" aria-label="Часовой пояс" value={zone ?? ''} onChange={(e) => choose(e.target.value)}>
        <option value="">Как на телефоне{phone ? ` (${label(phone)})` : ''}</option>
        {options.map(([z]) => <option key={z} value={z}>{label(z)}</option>)}
      </select>
      {error && <p className="error" role="alert">{error}</p>}
    </section>
  )
}
