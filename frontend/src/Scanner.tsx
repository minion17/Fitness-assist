// Live barcode scanning from the camera inside the Mini App. Falls back to a gallery photo or typed digits
// when the camera isn't available (permission denied, old WebView).
import { useEffect, useRef, useState } from 'react'
import { readBarcode } from './barcode'
import { useBack } from './back'
import { haptic } from './haptics'

export default function Scanner({ onCode, onPhoto, onManual, onClose, note }: {
  note?: string // scanning in a row: what's been added so far
  onCode: (code: string) => void
  onPhoto: (file: File) => void
  onManual: () => void
  onClose: () => void
}) {
  useBack(onClose)
  const video = useRef<HTMLVideoElement>(null)
  const [error, setError] = useState('')
  const onCodeRef = useRef(onCode) // the camera must not restart when the parent re-renders
  useEffect(() => { onCodeRef.current = onCode })

  useEffect(() => {
    let stream: MediaStream | null = null
    let stopped = false
    const canvas = document.createElement('canvas')

    async function loop() {
      const v = video.current
      if (stopped || !v) return
      if (v.readyState >= 2 && v.videoWidth) {
        // only the band inside the frame: smaller image, faster decode, fewer stray codes
        const w = Math.round(v.videoWidth * 0.8), h = Math.round(v.videoHeight * 0.5)
        canvas.width = w
        canvas.height = h
        const ctx = canvas.getContext('2d', { willReadFrequently: true })!
        ctx.drawImage(v, (v.videoWidth - w) / 2, (v.videoHeight - h) / 2, w, h, 0, 0, w, h)
        const code = await readBarcode(ctx.getImageData(0, 0, w, h)).catch(() => null)
        if (code && !stopped) {
          stopped = true
          haptic('success')
          onCodeRef.current(code)
          return
        }
      }
      setTimeout(loop, 150)
    }

    ;(async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error('unsupported')
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false,
        })
        if (stopped) return
        video.current!.srcObject = stream
        await video.current!.play().catch(() => {})
        loop()
      } catch (e) {
        const denied = e instanceof DOMException && e.name === 'NotAllowedError'
        setError(denied
          ? 'Нет доступа к камере. Разреши его Telegram в настройках телефона или выбери фото.'
          : 'Камера недоступна в этой версии Telegram — выбери фото штрихкода или введи цифры.')
      }
    })()
    return () => { stopped = true; stream?.getTracks().forEach((t) => t.stop()) }
  }, [])

  return (
    <div className="scanner" role="dialog" aria-label="Сканер штрихкода">
      <video ref={video} playsInline muted autoPlay />
      {!error && <div className="scan-frame" aria-hidden="true"><i /></div>}
      <div className="scan-top">
        <button className="link" onClick={onClose}>Закрыть</button>
      </div>
      <div className="scan-bottom">
        {note && !error && <p className="scan-note">{note}</p>}
        <p className={error ? 'error' : 'sub'}>{error || 'Наведи камеру на штрихкод или квадратный код «Честного знака»'}</p>
        <div className="meal-actions">
          <label className="link">
            Фото из галереи
            <input type="file" accept="image/*" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) onPhoto(f) }} />
          </label>
          <button className="link" onClick={onManual}>Ввести цифры</button>
        </div>
      </div>
    </div>
  )
}
