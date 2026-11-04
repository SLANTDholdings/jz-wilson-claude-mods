import { expect, test } from 'claude-code/testing'
import { MOVED_TO } from './register'

test('pointer stub', async () => {
  expect(MOVED_TO).toContain('terminal-mods/chat-inventory/hooks/register.tsx')
})
