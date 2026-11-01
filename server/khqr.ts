import { createHash, randomBytes } from 'node:crypto'

export type KhqrConfig = {
  bakongId: string
  merchantName: string
  city: string
  demo: boolean
}

function byteLength(value: string) {
  return new TextEncoder().encode(value).length
}

function tlv(tag: string, value: string) {
  return `${tag}${byteLength(value).toString().padStart(2, '0')}${value}`
}

export function crc16(payload: string) {
  const bytes = new TextEncoder().encode(payload)
  let crc = 0xffff
  for (const byte of bytes) {
    crc ^= byte << 8
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 0x8000 ? (crc << 1) ^ 0x1021 : crc << 1
      crc &= 0xffff
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0')
}

export type KhqrInput = {
  amount: number
  billNumber: string
  currency?: 'USD' | 'KHR'
}

const FREEMAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'outlook.com', 'hotmail.com',
  'live.com', 'icloud.com', 'proton.me', 'protonmail.com', 'telegram.local',
  'example.com',
])

/**
 * A real Bakong account ID looks like `sithy@aclb` (name or phone, then the
 * bank/biller code). Free email addresses are rejected so a merchant cannot
 * accidentally publish a QR code that pays nobody.
 */
export function isValidBakongId(value: string): boolean {
  const id = value.trim()
  if (!id || id.length > 64) return false
  const match = /^[A-Za-z0-9][A-Za-z0-9._-]{1,31}@([A-Za-z]{2,12})$/.exec(id)
  if (!match) return false
  return !FREEMAIL_DOMAINS.has(match[1].toLowerCase())
}

/**
 * Builds an EMVCo KHQR payload for Bakong. The account here is the merchant
 * Bakong ID configured in Admin → Payments. A real ID is required: the payload
 * must never fall back to a placeholder that cannot receive money.
 */
export function buildKhqr(config: KhqrConfig, { amount, billNumber, currency = 'USD' }: KhqrInput): string {
  if (!isValidBakongId(config.bakongId)) {
    throw new Error('A valid Bakong account ID is required to build a KHQR payload.')
  }
  const account = config.bakongId.trim()
  const merchant = (config.merchantName.trim() || 'SOVANNAPHUMTRADE').slice(0, 25)
  const city = (config.city.trim() || 'Phnom Penh').slice(0, 15)

  let payload = ''
  payload += tlv('00', '01')
  payload += tlv('01', '12')
  payload += tlv('29', tlv('00', account))
  payload += tlv('52', '5999')
  payload += tlv('53', currency === 'USD' ? '840' : '116')
  payload += tlv('54', Number(amount).toFixed(2))
  payload += tlv('58', 'KH')
  payload += tlv('59', merchant)
  payload += tlv('60', city)
  payload += tlv('62', tlv('01', billNumber))
  payload += '6304'

  return payload + crc16(payload)
}

export function khqrMd5(payload: string) {
  return createHash('md5').update(payload).digest('hex')
}

export function billNumber() {
  return `SVN${Date.now().toString(36).toUpperCase()}${randomBytes(2).toString('hex').toUpperCase()}`
}
