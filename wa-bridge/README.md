# wa-bridge

WhatsApp bridge for the Fermi daemon (Baileys). Inbound messages are posted to
`FERMI_URL/wa/webhook`; outbound messages are polled from `FERMI_URL/wa/outbox`
and sent through the paired device session in `~/fermi-daemon/wa-auth/`.

```
npm run pair -- <E164 digits>   # one-time device pairing
npm start                       # run mode (what the LaunchAgent does)
npm test                        # unit tests (node:test, no extra deps)
npm run typecheck
```

## Menciones

Outbound group messages containing `@Nombre` are turned into real WhatsApp
mentions (blue, notifying) before `sock.sendMessage`. The outbox contract is
unchanged: the server still hands us `{chat_id, body}`.

**How a name is resolved** (first hit wins):

1. `state/mention-aliases.json` — manual aliases, exact then case/accent-insensitive:
   ```json
   { "1203634...@g.us": { "Pollito": "11600723472408@lid", "Sebastián": "15551234567" } }
   ```
   Values may be `@lid`, `@s.whatsapp.net`, or bare digits (treated as a phone).
   The file is re-read when it changes; no restart needed.
2. `state/mentions.json` — auto-built directory `{groupJid: [{pn, lid, names}]}`.
   Filled from each inbound group message (`key.participant` / `participantAlt`
   + `pushName`) and from `groupMetadata()` on the first send to a group
   (participants' `id`/`lid`/`phoneNumber` + `notify`/`name`, cached 10 min).
   Match order: exact name, folded (lowercase, no accents), unique prefix.
3. `@<dígitos>` of a known member (phone or LID) is also recognised.

Token syntax: `@Nombre` (letters, digits, `_`, inner `.`/`'`/`-`; stops at
spaces and punctuation) or `@[Nombre Con Espacios]`. Tokens glued to a word
(`a@b.com`) are ignored. Unresolved tokens are left as plain text; sending
never fails because of a mention.

**LID vs phone jid.** WhatsApp renders the mention only if the digits in the
text match the jid in `mentions`. Groups now report an `addressingMode`
(`lid` or `pn`); by default (`WA_MENTION_JID_MODE=auto`) we use the member's
LID (`@lid`) in LID groups and the phone jid (`@s.whatsapp.net`) in PN groups.
Override with `WA_MENTION_JID_MODE=lid|pn` in `~/fermi-daemon/.env` if a group
misbehaves. The `@11600723472408` seen in inbound text is a LID, not a phone,
which is why LID groups must mention with `…@lid`.

**Chunking.** Long bodies are split at 4000 chars; a cut never lands inside an
`@digits` token, and each chunk carries only the mentions it contains.

**Debug log.** `WA_BRIDGE_DEBUG=1` in `.env` logs detected/resolved/unresolved
tokens and each group's addressing mode.

**Manual test.**
```
npm run mention-test -- <groupJid> "@Pollito prueba"
```
Prints the known members for the group and the resolution in both jid modes,
then queues the message in `state/mention-test-queue.jsonl`; the running bridge
picks it up on its next poll and sends it (it owns the session, so the script
never opens a second socket). Confirm on the phone that the mention is blue.
