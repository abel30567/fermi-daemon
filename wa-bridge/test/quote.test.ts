import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Member } from '../src/mentions.ts'
import { quotePrefix } from '../src/quote.ts'

const members: Member[] = [{ pn: '15555550111@s.whatsapp.net', lid: '20000000000000@lid', names: ['Member One'] }]
const self = ['15555550100:12@s.whatsapp.net', '10000000000000:12@lid']

test('no quote -> null', () => {
	assert.equal(quotePrefix(undefined, members, self), null)
	assert.equal(quotePrefix({ stanzaId: 'x' }, members, self), null)
})

test('quote of a member by lid resolves the name', () => {
	const ctx = { participant: '20000000000000@lid', quotedMessage: { conversation: 'Hola\n  mundo' } }
	assert.equal(quotePrefix(ctx, members, self), '[replying to Member One: "Hola mundo"]')
})

test("quote of the bot's own message reads Fermi", () => {
	const ctx = { participant: '10000000000000@lid', quotedMessage: { extendedTextMessage: { text: 'Honestly, it changed' } } }
	assert.equal(quotePrefix(ctx, members, self), '[replying to Fermi: "Honestly, it changed"]')
})

test('unknown pn falls back to digits, media placeholder, long text clipped', () => {
	assert.equal(
		quotePrefix({ participant: '15555550199@s.whatsapp.net', quotedMessage: { imageMessage: {} } }, members, self),
		'[replying to 15555550199: "[image]"]',
	)
	const long = 'a'.repeat(400)
	const out = quotePrefix({ participant: '1@lid', quotedMessage: { conversation: long } }, members, self)!
	assert.equal(out, `[replying to someone: "${'a'.repeat(300)}…"]`)
})
