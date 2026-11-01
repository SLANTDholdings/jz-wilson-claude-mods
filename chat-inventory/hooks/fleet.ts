// Fleet: the Codex/Grok/Gemini jobs Bebe launched through ~/.bebe-tools/fleet-go, read from the shared activity log.
import type { EngineInterface } from 'claude-code'

export type FleetJob = { id: string; who: string; label: string; start: string; end?: string; result?: string; pid?: string; alive?: boolean }

export const fleetLogPath = (home: string) => `${home}/.claude/mods-state/fleet-activity.jsonl`

/** Running jobs of any age plus jobs from the last 18 hours, running first then newest; a start with no end whose process is gone reads DIED. Never throws. */
export async function readFleet($: EngineInterface, home: string): Promise<FleetJob[]> {
  try {
    const path = fleetLogPath(home)
    if (!(await $.fs.exists(path))) return []
    const byId = new Map<string, FleetJob>()
    for (const line of String(await $.fs.read(path)).split('\n')) {
      if (!line.trim()) continue
      let o: Record<string, string>
      try {
        o = JSON.parse(line)
      } catch {
        continue
      }
      if (!o.id) continue
      byId.set(o.id, { ...(byId.get(o.id) ?? { id: o.id, who: '', label: '', start: '' }), ...o } as FleetJob)
    }
    // Liveness is checked for every unfinished job, whatever its age: a long job (a day-long backup)
    // must keep its seat active. Only finished or dead jobs age out after 18 hours.
    const all = [...byId.values()].filter(j => j.start)
    const open = all.filter(j => !j.end && j.pid)
    if (open.length) {
      const r = await $.process.run(['ps', '-o', 'pid=', '-p', open.map(j => j.pid).join(',')]).catch(() => null)
      const live = new Set(String((r as { stdout?: unknown } | null)?.stdout ?? '').split(/\s+/).filter(Boolean))
      for (const j of open) j.alive = live.has(String(j.pid))
    }
    const since = Date.now() - 18 * 3600_000
    const jobs = all.filter(j => (!j.end && j.alive) || Date.parse(j.start) >= since)
    const running = (j: FleetJob) => (!j.end && j.alive ? 1 : 0)
    return jobs.sort((a, b) => running(b) - running(a) || b.start.localeCompare(a.start))
  } catch {
    return []
  }
}

/** The mark, its colour role and the right-hand word for one job. */
export function fleetMark(j: FleetJob): { mark: string; tone: 'accent' | 'good' | 'warn' | 'bad' | 'dim'; word: string } {
  if (!j.end) {
    if (j.alive === false) return { mark: '✗', tone: 'bad', word: 'died' }
    const mins = Math.max(0, Math.round((Date.now() - Date.parse(j.start)) / 60000))
    return { mark: '▶', tone: 'accent', word: `${mins}m` }
  }
  switch (j.result) {
    case 'PASS':
      return { mark: '✓', tone: 'good', word: 'pass' }
    case 'AMEND':
      return { mark: '✎', tone: 'warn', word: 'amend' }
    case 'DONE':
      return { mark: '✓', tone: 'dim', word: 'done' }
    case 'BLOCKED':
      return { mark: '✗', tone: 'bad', word: 'blocked' }
    default:
      return { mark: '✗', tone: 'bad', word: 'failed' }
  }
}

export const EYE = '👁️'
/** A step that needs AZ starts with the eye; the panel lifts it into its own column. */
// AZ picked 👁️ (2026-10-24); a bare 👁 or the older 👀 still count.
const EYES = ['👁️', '👁', '👀']
export const needsAz = (text: string) => EYES.some(e => text.startsWith(e))
export const stripEye = (text: string) => { const e = EYES.find(x => text.startsWith(x)); return e ? text.slice(e.length).trimStart() : text }

// Seats: every identity in the fleet registry, with what it is doing now.
export type Seat = { id: string; name: string; harness: string; status: 'active' | 'idle' | 'exhausted' | 'off'; until?: string; why?: string; note?: string; jobs: FleetJob[] }

async function readJson($: EngineInterface, path: string): Promise<any> {
  try {
    return (await $.fs.exists(path)) ? JSON.parse(String(await $.fs.read(path))) : undefined
  } catch {
    return undefined
  }
}

/** One row per registry seat; a job by an id not in the registry gets its own row. Exhausted comes from the
 *  fleet's usage files (a rejected window, or 100% used) and from fleet-go's out-of-credit marks. Never throws. */
export async function readSeats($: EngineInterface, home: string, jobs: FleetJob[]): Promise<Seat[]> {
  try {
    const reg = (await readJson($, `${home}/.claude-fleet/registry.json`))?.identities ?? []
    const marks = (await readJson($, `${home}/.claude/mods-state/fleet-seats.json`)) ?? {}
    const now = Date.now()
    const seats: Seat[] = []
    const seen = new Set<string>()
    const add = (id: string, name: string, harness: string, active: boolean) => {
      seen.add(id)
      const mine = jobs.filter(j => j.who === id)
      const running = mine.some(j => !j.end && j.alive)
      let status: Seat['status'] = !active ? 'off' : running ? 'active' : 'idle'
      let until: string | undefined
      let why: string | undefined
      const mark = marks[id]
      if (mark?.exhausted && (!mark.until || Date.parse(mark.until) > now)) {
        status = running ? 'active' : 'exhausted'
        until = mark.until
        why = mark.why
      }
      seats.push({ id, name, harness, status, until, why, note: mark?.note, jobs: mine })
      return seats[seats.length - 1]
    }
    for (const r of reg) {
      const seat = add(r.id, (r.name || r.id).toLowerCase(), r.harness || '', r.active !== false)
      const u = await readJson($, `${home}/.claude-fleet/usage/${r.id}.json`)
      if (!u || seat.status === 'active') continue
      const full = Object.values(u.windows ?? {}).find((w: any) => (w?.usedPercentage ?? 0) >= 100) as any
      if (u.rejected || full) {
        const at = full?.resetsAt ?? (u.retryAfterSeconds ? u.observedAt + u.retryAfterSeconds * 1000 : null)
        if (!at || at > now) {
          seat.status = 'exhausted'
          seat.until = at ? new Date(at).toISOString() : seat.until
          seat.why = seat.why ?? 'usage limit'
        }
      }
    }
    for (const j of jobs) if (!seen.has(j.who)) add(j.who, j.who, '', true)
    // Fixed lineup: registry order, never reshuffled by status (AZ 2026-10-24).
    return seats
  } catch {
    return []
  }
}

/** "3:40 PM" today, "Sun 3:40 PM" within a week, else the date. */
export function whenBack(iso?: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  const t = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  const days = (d.getTime() - Date.now()) / 86400_000
  if (d.toDateString() === new Date().toDateString()) return t
  if (days < 7) return `${d.toLocaleDateString('en-US', { weekday: 'short' })} ${t}`
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}
