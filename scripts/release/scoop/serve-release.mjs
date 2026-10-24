#!/usr/bin/env node
// A loopback file server for the Windows package leg's Scoop check (scoop-check.ps1): Scoop downloads the zip the leg
// just built from it, so the check fetches nothing from the internet and Scoop verifies the manifest hash against the
// real file.
//
//   node scripts/release/scoop/serve-release.mjs <dir> <url file>   serves the top-level files of <dir> on
//                                                                   127.0.0.1, writes its base url into <url file>
//                                                                   and runs until it is ended
//
// Only a plain top-level file name is served (no separator, no `..`); anything else is 404. GET and HEAD only.
import { createReadStream, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PLAIN_NAME = /^[\w.+-]+$/

/** The file of `dir` a request path names, or null. */
function fileOf(dir, requestPath) {
  let name
  try {
    name = decodeURIComponent(requestPath.replace(/^\//, '').split('?')[0])
  } catch {
    return null
  }
  if (!PLAIN_NAME.test(name) || name === '.' || name === '..') return null
  const file = path.join(dir, name)
  try {
    return statSync(file).isFile() ? file : null
  } catch {
    return null
  }
}

/** Starts the server on a free loopback port; answers its base url and a close function. */
export function startReleaseServer(dir) {
  const server = createServer((request, response) => {
    const file =
      request.method === 'GET' || request.method === 'HEAD' ? fileOf(dir, request.url ?? '') : null
    if (file === null) {
      response.writeHead(404).end()
      return
    }
    response.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': statSync(file).size
    })
    if (request.method === 'HEAD') response.end()
    else createReadStream(file).pipe(response)
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () =>
      resolve({
        url: `http://127.0.0.1:${server.address().port}/`,
        close: () => new Promise((done) => server.close(() => done()))
      })
    )
  })
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [dir, urlFile] = process.argv.slice(2)
  if (!dir || !urlFile) {
    console.error('usage: node scripts/release/scoop/serve-release.mjs <dir> <url file>')
    process.exit(2)
  }
  const { url } = await startReleaseServer(path.resolve(dir))
  writeFileSync(urlFile, url)
  console.log(`serve-release: ${url}`)
}
