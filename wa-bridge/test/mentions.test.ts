import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { chunkText, MentionDirectory, type Member, mentionsIn, parseTokens, resolveMentions } from '../src/mentions.ts'

const members: Member[] = [
	{ pn: '15555554567@s.whatsapp.net', lid: '10000000000000@lid', names: ['Pollito'] },
	{ pn: '15555556543@s.whatsapp.net', names: ['Sebastián Rojas'] },
	{ lid: '15555550222@lid', names: ['Sebas'] },
	{ pn: '15555550001@s.whatsapp.net', names: ['Juan Pérez'] },
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
	assert.equal(lid.text, '@10000000000000 y @15555550001')
	assert.deepEqual(lid.mentions, ['10000000000000@lid', '15555550001@s.whatsapp.net'])
	const pn = resolveMentions('@Pollito', members, {}, 'pn')
	assert.equal(pn.text, '@15555554567')
	assert.deepEqual(pn.mentions, ['15555554567@s.whatsapp.net'])
})

test('case/accent-insensitive and unique prefix; ambiguous prefix left intact', () => {
	const r = resolveMentions('@pollito @juan @Seb', members, {}, 'pn')
	assert.equal(r.text, '@15555554567 @15555550001 @Seb')
	assert.deepEqual(r.unresolved, ['@Seb'])
	assert.equal(resolveMentions('@sebastian', members, {}, 'pn').text, '@15555556543')
})

test('aliases take priority over pushName and may be bare digits', () => {
	const aliases = { Pollito: '15555550001@s.whatsapp.net', Nuevo: '15555557777' }
	const r = resolveMentions('@Pollito @nuevo', members, aliases, 'pn')
	assert.equal(r.text, '@15555550001 @15555557777')
	assert.deepEqual(r.mentions, ['15555550001@s.whatsapp.net', '15555557777@s.whatsapp.net'])
})

test('raw @digits of a known member is turned into a mention', () => {
	const r = resolveMentions('@10000000000000 hola', members, {}, 'lid')
	assert.deepEqual(r.mentions, ['10000000000000@lid'])
	assert.equal(resolveMentions('@10000000000000', members, {}, 'pn').text, '@15555554567')
})

test('unknown names never alter the text', () => {
	const r = resolveMentions('@Nadie dijo @[Otra Persona]', members, {}, 'lid')
	assert.equal(r.text, '@Nadie dijo @[Otra Persona]')
	assert.deepEqual(r.mentions, [])
	assert.equal(resolveMentions('sin menciones', members, {}, 'lid').text, 'sin menciones')
})

test('chunkText never splits an @digits token; mentionsIn picks per chunk', () => {
	const text = `${'x'.repeat(8)}@15555554567 fin`
	const chunks = chunkText(text, 12)
	assert.deepEqual(chunks, ['xxxxxxxx', '@15555554567', ' fin'])
	assert.equal(chunks.join(''), text)
	assert.deepEqual(mentionsIn(chunks[1], ['15555554567@s.whatsapp.net', '1@lid']), ['15555554567@s.whatsapp.net'])
	assert.deepEqual(chunkText('corto', 4000), ['corto'])
})

test('MentionDirectory merges sightings, persists, and reloads aliases', () => {
	const dir = mkdtempSync(join(tmpdir(), 'mentions-'))
	const d = new MentionDirectory(dir)
	const g = '123@g.us'
	d.record(g, { lid: '10000000000000@lid', name: 'Pollito' })
	d.record(g, { lid: '10000000000000@lid', pn: '15555554567@s.whatsapp.net', name: 'Pollito' })
	d.record(g, { name: 'sin jid' })
	assert.deepEqual(d.members(g), [{ names: ['Pollito'], lid: '10000000000000@lid', pn: '15555554567@s.whatsapp.net' }])
	d.save()
	assert.deepEqual(new MentionDirectory(dir).members(g), d.members(g))
	assert.ok(readFileSync(join(dir, 'mentions.json'), 'utf8').includes('Pollito'))

	writeFileSync(join(dir, 'mention-aliases.json'), JSON.stringify({ [g]: { Pollo: '15555554567@s.whatsapp.net' } }))
	assert.equal(d.resolve(g, '@pollo', 'lid').text, '@10000000000000')
})
