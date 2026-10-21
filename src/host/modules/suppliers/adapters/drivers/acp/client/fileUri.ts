// The `file://` URI of a Host-revalidated path (#1463), for the `resource_link` block an ACP prompt
// names a file with. Built by hand rather than with `node:url` `pathToFileURL`, whose result depends
// on the OS the Host runs on: the shape of the path decides. A drive-letter (`C:\…`, `C:/…`) or UNC
// (`\\server\share\…`) path is a Windows one, whose backslashes are separators; any other path is a
// POSIX one, where a backslash is a character of the name. Each segment is percent-encoded.

const DRIVE = /^[A-Za-z]:[\\/]/
const UNC = /^\\\\[^\\/]+[\\/]/

/** `file:///work/a%20b.txt`, `file:///C:/work/a.png`, `file://server/share/x.txt`. */
export function fileUriOf(path: string): string {
  if (UNC.test(path)) {
    const [server = '', ...rest] = path.slice(2).split(/[\\/]/)
    return `file://${encodeURIComponent(server)}/${encodedSegments(rest)}`
  }
  if (DRIVE.test(path)) {
    const [drive = '', ...rest] = path.split(/[\\/]/)
    return `file:///${drive}/${encodedSegments(rest)}`
  }
  return `file://${encodedSegments(path.split('/'))}`
}

function encodedSegments(segments: readonly string[]): string {
  return segments.map((segment) => encodeURIComponent(segment)).join('/')
}
