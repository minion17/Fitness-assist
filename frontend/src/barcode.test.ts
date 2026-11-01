import { expect, test } from 'vitest'
import { toGtin } from './barcode'

test('product code from EAN and Честный знак DataMatrix', () => {
  expect(toGtin('4602433005667')).toBe('4602433005667')
  expect(toGtin('46024330')).toBe('46024330')
  // GS1 DataMatrix: (01) GTIN-14, (21) serial, separators, crypto tail
  expect(toGtin('0104602433005667215!aB3c\x1d93dGVz')).toBe('4602433005667')
  expect(toGtin(']d20104602433005667215!aB3c')).toBe('4602433005667')
  expect(toGtin('https://example.com/qr')).toBeNull()
  expect(toGtin('123')).toBeNull()
})
