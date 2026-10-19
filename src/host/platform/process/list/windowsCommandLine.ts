// A Windows command line split the way the C runtime splits it, enough to name a stem: double
// quotes group, a backslash is literal unless it precedes a quote. Adopted from spike S-014-1
// (`spikes/S-014-1/pidSource.ts`).
export function splitWindowsCommandLine(line: string): string[] {
  const args: string[] = []
  let current = ''
  let quoted = false
  let started = false
  for (let i = 0; i < line.length; i++) {
    const char = line[i] as string
    if (char === '\\' && line[i + 1] === '"') {
      current += '"'
      i++
      started = true
    } else if (char === '"') {
      quoted = !quoted
      started = true
    } else if (/\s/.test(char) && !quoted) {
      if (started) args.push(current)
      current = ''
      started = false
    } else {
      current += char
      started = true
    }
  }
  if (started) args.push(current)
  return args
}
