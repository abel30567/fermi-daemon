const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('baileys')
const QRCode = require('qrcode')
const pino = require('pino')
const path = require('path')
const fs = require('fs')

const AUTH_DIR = path.join(process.env.HOME, 'fermi-daemon/wa-auth')
const QR_IMG = path.join(process.env.HOME, 'fermi-daemon/wa-bridge/qr.png')
const STATUS_FILE = path.join(process.env.HOME, 'fermi-daemon/wa-bridge/pair-status.txt')

fs.rmSync(AUTH_DIR, { recursive: true, force: true })
fs.mkdirSync(AUTH_DIR, { recursive: true, mode: 0o700 })
fs.writeFileSync(STATUS_FILE, 'starting')

let qrCount = 0

async function connect() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)
  const sock = makeWASocket({
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update

    if (qr) {
      qrCount++
      console.log(`QR #${qrCount} received, saving to qr.png ...`)
      await QRCode.toFile(QR_IMG, qr, { width: 512, margin: 2 })
      fs.writeFileSync(STATUS_FILE, `qr:${qrCount}:${Date.now()}`)
      console.log(`QR #${qrCount} saved. Scan it within 20 seconds!`)
    }

    if (connection === 'open') {
      console.log('\nCONNECTED as', sock.user?.id)
      fs.writeFileSync(STATUS_FILE, 'connected:' + (sock.user?.id || ''))
      try { fs.unlinkSync(QR_IMG) } catch {}
      // remove LOGGED_OUT marker if present
      const marker = path.join(AUTH_DIR, '..', 'wa-auth', '..', 'wa-auth', 'LOGGED_OUT')
      try { fs.unlinkSync(path.join(process.env.HOME, 'fermi-daemon/wa-auth/LOGGED_OUT')) } catch {}
      setTimeout(() => process.exit(0), 2000)
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode
      if (code === DisconnectReason.loggedOut) {
        console.log('Logged out')
        fs.writeFileSync(STATUS_FILE, 'logged_out')
        process.exit(1)
      }
      if (code === DisconnectReason.restartRequired) {
        console.log('Restarting (normal after pairing)...')
        fs.writeFileSync(STATUS_FILE, 'restarting')
        connect()
        return
      }
      console.log('Connection closed (' + code + '), retrying...')
      fs.writeFileSync(STATUS_FILE, 'retrying:' + code)
      setTimeout(connect, 2000)
    }
  })
}

console.log('Starting QR pairing...')
connect()
