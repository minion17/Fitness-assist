// Telegram Stories (Bot API 7.8+): the server draws a 9:16 card and gives a short-lived public link to it.
import { api, postJson, tg, tgUser } from './telegram'

export const canStory = () => Boolean(tg?.shareToStory && tg.isVersionAtLeast?.('7.8'))

export async function shareStory(body: { kind: 'week' } | { kind: 'duel'; duel_id: number }) {
  const r = await api<{ url: string; text: string; link: string | null }>('/api/story', postJson(body))
  if (!r || !tg?.shareToStory) return
  // a link sticker is for Premium only; others get the invite link in the caption
  const widget = tgUser?.is_premium && r.link ? { widget_link: { url: r.link, name: 'Setly' } } : {}
  tg.shareToStory(new URL(r.url, window.location.href).href, { text: r.text.slice(0, tgUser?.is_premium ? 2048 : 200), ...widget })
}
