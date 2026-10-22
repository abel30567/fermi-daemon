import { SocketModeClient } from '@slack/socket-mode'
import { WebClient } from '@slack/web-api'
import { type Config, loadConfig } from './config.ts'
import { buildInbound, forwardToWorker, type SlackMessageEvent } from './inbound.ts'
import { log } from './log.ts'
import { startOutboxLoop } from './outbox.ts'

process.on('unhandledRejection', (reason) => {
	log(`FATAL unhandledRejection: ${String(reason)}`)
	process.exit(1)
})
process.on('uncaughtException', (err) => {
	log(`FATAL uncaughtException: ${String(err)}`)
	process.exit(1)
})

type SlackEnvelope = {
	team_id?: string
	event?: SlackMessageEvent
}

async function main(): Promise<void> {
	const config = loadConfig()
	log('starting sl-bridge')

	const web = new WebClient(config.SLACK_BOT_TOKEN)
	const nameCache = new Map<string, string>()

	let botUserId: string | undefined
	try {
		const auth = await web.auth.test()
		if (!auth.ok || typeof auth.user_id !== 'string') {
			throw new Error(auth.error ?? 'auth.test failed')
		}
		botUserId = auth.user_id
		log(`authenticated as ${auth.user ?? auth.user_id} (${auth.user_id})`)
	} catch (err) {
		log(`FATAL auth.test failed: ${String(err)}`)
		process.exit(1)
	}

	async function resolveName(userId: string): Promise<string> {
		const cached = nameCache.get(userId)
		if (cached) return cached
		try {
			const info = await web.users.info({ user: userId })
			const user = info.user
			const name =
				user?.profile?.display_name ||
				user?.profile?.real_name ||
				user?.real_name ||
				user?.name ||
				userId
			nameCache.set(userId, name)
			return name
		} catch (err) {
			log(`warn: users.info failed for ${userId}: ${String(err)}`)
			return userId
		}
	}

	const socket = new SocketModeClient({ appToken: config.SLACK_APP_TOKEN })

	let connected = false
	socket.on('connected', () => {
		connected = true
		log('socket mode connected')
	})
	socket.on('disconnected', () => {
		connected = false
		log('socket mode disconnected — client will reconnect')
	})
	socket.on('error', (err: unknown) => {
		log(`client error: ${String(err)}`)
	})

	socket.on(
		'slack_event',
		async ({ ack, body }: { ack: () => Promise<void>; body: SlackEnvelope }) => {
			// Ack first so Slack does not retry while we forward.
			await ack()
			const event = body.event
			if (!event || event.type !== 'message') return
			if (event.bot_id || event.subtype || event.hidden) return
			const text = event.text
			const authorId = event.user
			const channelId = event.channel
			if (!text || !authorId || !channelId) return
			if (botUserId && authorId === botUserId) return

			const displayName = await resolveName(authorId)
			const teamId = body.team_id ?? event.team ?? null
			forwardToWorker(
				config,
				buildInbound({ ...event, user: authorId, channel: channelId, text }, displayName, teamId),
			).catch((err) => {
				log(`forwardToWorker error: ${String(err)}`)
			})
		},
	)

	try {
		await socket.start()
	} catch (err) {
		log(`FATAL socket start failed: ${String(err)}`)
		process.exit(1)
	}
	// Outbound attachments: the worker queues them for this bridge because the
	// files live on this Mac. Web API calls work regardless of Socket Mode, but
	// gate on it so a disconnected bridge does not keep draining.
	startOutboxLoop(config, web, () => connected)
}

main().catch((err) => {
	log(`FATAL: ${String(err)}`)
	process.exit(1)
})
