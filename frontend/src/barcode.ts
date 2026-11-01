// Read an EAN/UPC barcode from a photo. Native BarcodeDetector where the WebView has it (Android),
// otherwise ZXing, loaded only when first needed so it doesn't weigh on app start.
type Detector = { detect(src: ImageBitmapSource): Promise<{ rawValue: string }[]> }
declare global {
  interface Window { BarcodeDetector?: new (o: { formats: string[] }) => Detector }
}

const FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e']

async function toCanvas(file: Blob, max = 1600): Promise<HTMLCanvasElement> {
  const bmp = await createImageBitmap(file)
  const k = Math.min(1, max / Math.max(bmp.width, bmp.height))
  const c = document.createElement('canvas')
  c.width = Math.round(bmp.width * k)
  c.height = Math.round(bmp.height * k)
  c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height)
  return c
}

export async function readBarcode(file: Blob): Promise<string | null> {
  const canvas = await toCanvas(file)
  if (window.BarcodeDetector) {
    try {
      const [hit] = await new window.BarcodeDetector({ formats: FORMATS }).detect(canvas)
      if (hit) return hit.rawValue
    } catch { /* unsupported format list on this device: fall through to ZXing */ }
  }
  const z = await import('@zxing/library')
  const { data, width, height } = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height)
  const lum = new Uint8ClampedArray(width * height)
  for (let i = 0; i < lum.length; i++) lum[i] = (data[i * 4] * 299 + data[i * 4 + 1] * 587 + data[i * 4 + 2] * 114) / 1000
  const reader = new z.MultiFormatReader()
  const hints = new Map<import("@zxing/library").DecodeHintType, unknown>([
    [z.DecodeHintType.POSSIBLE_FORMATS, [z.BarcodeFormat.EAN_13, z.BarcodeFormat.EAN_8, z.BarcodeFormat.UPC_A, z.BarcodeFormat.UPC_E]],
    [z.DecodeHintType.TRY_HARDER, true],
  ])
  try {
    const bmp = new z.BinaryBitmap(new z.HybridBinarizer(new z.RGBLuminanceSource(lum, width, height)))
    return reader.decode(bmp, hints).getText()
  } catch {
    return null // NotFoundException: no barcode in the photo
  }
}
