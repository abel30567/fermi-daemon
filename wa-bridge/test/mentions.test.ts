import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { chunkText, MentionDirectory, type Member, mentionsIn, parseTokens, resolveMentions } from '../src/mentions.ts'

const members: Member[] = [
	{ pn: '15551234567@s.whatsapp.net', lid: '11600723472408@lid', names: ['Pollito'] },
	{ pn: '15559876543@s.whatsapp.net', names: ['Sebastián Rojas'] },
	{ lid: '22222222222@lid', names: ['Sebas'] },
	{ pn: '15550000001@s.whatsapp.net', names: ['Juan Pérez'] },
]

test('parseTokens: simple, bracketed, accents, trailing punctuation, emails', () => {
	const t = parseTokens('hola @Pollito, @[Juan Pérez] y @Sebastián. mail a@b.com @ñandú!')
	assert.deepEqual(
		t.map((x) => x.name),
		['Pollito', 'Juan Pérez', 'Sebastián', 'ñandú'],
	)
	assert.equal(t[2].token, '@Sebastián')
})

test('resolve exact and bracketed names, lid vs pn mode', () => {
	const lid = resolveMentions('@Pollito y @[Juan Pérez]', members, {}, 'lid')
	assert.equal(lid.text, '@11600723472408 y @15550000001')
	assert.deepEqual(lid.mentions, ['11600723472408@lid', '15550000001@s.whatsapp.net'])
	const pn = resolveMentions('@Pollito', members, {}, 'pn')
	assert.equal(pn.text, '@15551234567')
	assert.deepEqual(pn.mentions, ['15551234567@s.whatsapp.net'])
})

test('case/accent-insensitive and unique prefix; ambiguous prefix left intact', () => {
	const r = resolveMentions('@pollito @juan @Seb', members, {}, 'pn')
	assert.equal(r.text, '@15551234567 @15550000001 @Seb')
	assert.deepEqual(r.unresolved, ['@Seb'])
	assert.equal(resolveMentions('@sebastian', members, {}, 'pn').text, '@15559876543')
})

test('aliases take priority over pushName and may be bare digits', () => {
	const aliases = { Pollito: '15550000001@s.whatsapp.net', Nuevo: '15557777777' }
	const r = resolveMentions('@Pollito @nuevo', members, aliases, 'pn')
	assert.equal(r.text, '@15550000001 @15557777777')
	assert.deepEqual(r.mentions, ['15550000001@s.whatsapp.net', '15557777777@s.whatsapp.net'])
})

test('raw @digits of a known member is turned into a mention', () => {
	const r = resolveMentions('@11600723472408 hola', members, {}, 'lid')
	assert.deepEqual(r.mentions, ['11600723472408@lid'])
	assert.equal(resolveMentions('@11600723472408', members, {}, 'pn').text, '@15551234567')
})

test('unknown names never alter the text', () => {
	const r = resolveMentions('@Nadie dijo @[Otra Persona]', members, {}, 'lid')
	assert.equal(r.text, '@Nadie dijo @[Otra Persona]')
	assert.deepEqual(r.mentions, [])
	assert.equal(resolveMentions('sin menciones', members, {}, 'lid').text, 'sin menciones')
})

test('chunkText never splits an @digits token; mentionsIn picks per chunk', () => {
	const text = `${'x'.repeat(8)}@15551234567 fin`
	const chunks = chunkText(text, 12)
	assert.deepEqual(chunks, ['xxxxxxxx', '@15551234567', ' fin'])
	assert.equal(chunks.join(''), text)
	assert.deepEqual(mentionsIn(chunks[1], ['15551234567@s.whatsapp.net', '1@lid']), ['15551234567@s.whatsapp.net'])
	assert.deepEqual(chunkText('corto', 4000), ['corto'])
})

test('MentionDirectory merges sightings, persists, and reloads aliases', () => {
	const dir = mkdtempSync(join(tmpdir(), 'mentions-'))
	const d = new MentionDirectory(dir)
	const g = '123@g.us'
	d.record(g, { lid: '11600723472408@lid', name: 'Pollito' })
	d.record(g, { lid: '11600723472408@lid', pn: '15551234567@s.whatsapp.net', name: 'Pollito' })
	d.record(g, { name: 'sin jid' })
	assert.deepEqual(d.members(g), [{ names: ['Pollito'], lid: '11600723472408@lid', pn: '15551234567@s.whatsapp.net' }])
	d.save()
	assert.deepEqual(new MentionDirectory(dir).members(g), d.members(g))
	assert.ok(readFileSync(join(dir, 'mentions.json'), 'utf8').includes('Pollito'))

	writeFileSync(join(dir, 'mention-aliases.json'), JSON.stringify({ [g]: { Pollo: '15551234567@s.whatsapp.net' } }))
	assert.equal(d.resolve(g, '@pollo', 'lid').text, '@11600723472408')
})
