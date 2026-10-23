// The permission and tool surface every daemon run gets, warm (warm-worker.mjs)
// and cold (bin/run-once.mjs) alike, so both see the same tools and settings.

// Server-level grants: Bash, all Fermi tools via the claude.ai connector, all
// Playwright tools (user-scope MCP, local browser) and Google Calendar.
export const ALLOWED_TOOLS = 'Bash,mcp__claude_ai_Fermi,mcp__playwright,mcp__claude_ai_Google_Calendar'

// Skip global user settings and hooks (they block/add latency, and can grant
// bypassPermissions). Matches the warm session's --setting-sources.
export const SETTING_SOURCES = 'project,local'
