import type { Register } from 'claude-code'

export const MOVED_TO = 'https://github.com/SLANTDholdings/software/blob/main/terminal-mods/chat-inventory/hooks/register.tsx'

export const register: Register = on => {
  on('session.start', async () => {})
}
