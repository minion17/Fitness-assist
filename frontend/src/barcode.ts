// Read a product barcode from a photo: EAN/UPC, or a «Честный знак» DataMatrix (its GS1 (01) field holds the EAN).
// Native BarcodeDetector first where the WebView has it (Android), then zxing-cpp (WebAssembly), loaded only on
// first scan and served from our own server.
type Detector = { detect(src: ImageBitmapSource): Promise<{ rawValue: string }[]> }
declare global {
  interface Window { BarcodeDetector?: new (o: { formats: string[] }) => Detector }
}

/** EAN-8/13 or UPC from a scanned value; null if it carries no product code. */
export function toGtin(raw: string): string | null {
  const t = raw.replace(/^\][a-zA-Z]\d/, '').replaceAll('\x1d', '') // symbology prefix, GS1 group separators
  const m = /^\d{8,14}$/.test(t) ? t : t.match(/^01(\d{14})/)?.[1]
  if (!m) return null
  return m.length === 14 && m.startsWith('0') ? m.slice(1) : m // GTIN-14 with a leading 0 is the EAN-13
}

async function native(file: Blob): Promise<string | null> {
  if (!window.BarcodeDetector) return null
  try {
    const hits = await new window.BarcodeDetector({ formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'data_matrix'] })
      .detect(await createImageBitmap(file))
    return hits.map((h) => toGtin(h.rawValue)).find(Boolean) ?? null
  } catch {
    return null // some devices reject part of the format list
  }
}

async function wasm(file: Blob): Promise<string | null> {
  const [{ readBarcodes, prepareZXingModule }, { default: wasmUrl }] = await Promise.all([
    import('zxing-wasm/reader'),
    import('zxing-wasm/reader/zxing_reader.wasm?url'),
  ])
  prepareZXingModule({ overrides: { locateFile: (path: string) => (path.endsWith('.wasm') ? wasmUrl : path) } })
  const hits = await readBarcodes(file, { formats: ['EAN13', 'EAN8', 'UPCA', 'UPCE', 'DataMatrix'], tryHarder: true })
  return hits.map((h) => toGtin(h.text)).find(Boolean) ?? null
}

export async function readBarcode(file: Blob): Promise<string | null> {
  return (await native(file)) ?? (await wasm(file))
}
