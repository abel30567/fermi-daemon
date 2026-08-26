const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('baileys')
const pino = require('pino')
const path = require('path')
const fs = require('fs')

const AUTH_DIR = path.join(process.env.HOME, 'fermi-daemon/wa-auth')
fs.rmSync(AUTH_DIR, { recursive: true, force: true })
fs.mkdirSync(AUTH_DIR, { recursive: true, mode: 0o700 })

async function connect() {
	const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)
	const sock = makeWASocket({
		auth: state,
		logger: pino({ level: 'silent' }),
		printQRInTerminal: true,
	})

	sock.ev.on('creds.update', saveCreds)

	sock.ev.on('connection.update', (update) => {
		const { connection, lastDisconnect } = update
		if (connection === 'open') {
			console.log('\n✓ CONNECTED as', sock.user?.id)
			console.log('Now run: launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.fermi.wa-bridge.plist')
			setTimeout(() => process.exit(0), 2000)
		}
		if (connection === 'close') {
			const code = lastDisconnect?.error?.output?.statusCode
			if (code === DisconnectReason.loggedOut) {
				console.log('✗ Logged out')
				process.exit(1)
			}
			if (code === DisconnectReason.restartRequired) {
				console.log('Restarting (normal after pairing)...')
				connect()
				return
			}
			console.log('Connection closed (' + code + '), retrying...')
			setTimeout(connect, 2000)
		}
	})
}

console.log('Scan the QR code below with WhatsApp > Linked Devices > Link a Device')
console.log('QR refreshes every ~20s. Have your phone camera ready!\n')
connect()
