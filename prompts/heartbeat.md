Fermi daemon heartbeat check-in.

1. Call `task_list` with status `claimed`, then status `failed`.
2. If a claimed task looks abandoned (claimed long ago, never completed), it will be reclaimed automatically on the next drain — note it in a `memory_write` (kind: event) only if it keeps recurring.
3. If any pending tasks show up, drain them following the same rules as a drain run: claim, work, `channel_send` the reply, `task_complete`.
4. If nothing needs attention, end the turn without sending any messages.
