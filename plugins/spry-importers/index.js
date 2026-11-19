// Spry importers: one plugin that brings kinds of file Spry does not open by itself into your notes -- EPUB books, OpenDocument text (.odt), Rich Text (.rtf), web pages (.html), a Notion
// export (.zip) and a Bear note (.textpack). Install it once and you have them all. It is also the example of an importer plugin: docs/plugins.md, "Importer plugins".
//
// An importer is a function handed a file and answering with notes: { notes: [{ name, folder?, markdown, images? }], report?: [words] } (docs/import-spec.md). It runs in a sealed background
// worker, so it is COPIED there as text: it can use nothing outside itself except the plugin's `library` (the helper functions below, which are copied too and may call each other by name).
// A picture is written in the markdown as ![alt](image:KEY) with its bytes under KEY; a link to another note of the same answer is written [text](import:Folder/Name.md), and Spry turns it
// into a link to where that note really is.

// ── helpers shared by the importers (the library) ──────────────────────────────────────────────

// A zip file: { names, read(name) -> bytes | null, text(name) -> words | null }. Parts stored or deflated.
async function unzip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const utf8 = new TextDecoder('utf-8')
  const parts = new Map()
  let end = -1
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i -= 1) if (view.getUint32(i, true) === 0x06054b50) { end = i; break }
  if (end < 0) throw new Error('This is not a zip file.')
  let at = view.getUint32(end + 16, true)
  for (let n = view.getUint16(end + 10, true); n > 0 && view.getUint32(at, true) === 0x02014b50; n -= 1) {
    const nameLength = view.getUint16(at + 28, true)
    const raw = bytes.subarray(at + 46, at + 46 + nameLength)
    const name = utf8.decode(raw)
    parts.set(name, { method: view.getUint16(at + 10, true), size: view.getUint32(at + 20, true), offset: view.getUint32(at + 42, true) })
    at += 46 + nameLength + view.getUint16(at + 30, true) + view.getUint16(at + 32, true)
  }
  const read = async (name) => {
    const part = parts.get(name)
    if (!part) return null
    if (part.size === 0xFFFFFFFF) throw new Error('This file is too big for this importer (a zip64 file).')
    const start = part.offset + 30 + view.getUint16(part.offset + 26, true) + view.getUint16(part.offset + 28, true)
    const packed = bytes.subarray(start, start + part.size)
    if (part.method === 0) return packed
    if (part.method !== 8) throw new Error('A part of this file is packed in a way this importer cannot read.')
    return new Uint8Array(await new Response(new Blob([packed]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer())
  }
  return { names: [...parts.keys()].filter((n) => !n.endsWith('/')), read, text: async (name) => { const data = await read(name); return data ? utf8.decode(data) : null } }
}

// The words of a file's bytes: UTF-8 (with or without a mark), UTF-16 with a mark, else the Windows Western encoding that old files use.
function decodeText(bytes) {
  if (bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) return new TextDecoder('utf-8').decode(bytes.subarray(3))
  if (bytes[0] === 0xFF && bytes[1] === 0xFE) return new TextDecoder('utf-16le').decode(bytes.subarray(2))
  if (bytes[0] === 0xFE && bytes[1] === 0xFF) return new TextDecoder('utf-16be').decode(bytes.subarray(2))
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch (e) { return new TextDecoder('windows-1252').decode(bytes) }
}

function decodeEntities(value) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', copy: '©', reg: '®', trade: '™', bull: '•', middot: '·', laquo: '«', raquo: '»', euro: '€', pound: '£', deg: '°', times: '×', divide: '÷' }
  return String(value)
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex) => { try { return String.fromCodePoint(parseInt(hex, 16)) } catch (e) { return '' } })
    .replace(/&#(\d+);/g, (_m, number) => { try { return String.fromCodePoint(Number(number)) } catch (e) { return '' } })
    .replace(/&([a-zA-Z]+);/g, (whole, name) => (name in named ? named[name] : whole))
}

function attribute(tag, name) {
  const found = new RegExp(`(?:^|[\\s<])${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(tag)
  return found ? (found[1] !== undefined ? found[1] : found[2]) : null
}

// Words that markdown would take for marks are put behind a backslash.
function escapeText(value) {
  return value.replace(/([\\`*_[\]<])/g, '\\$1')
}

// XML as a tree: { name, attrs, kids } where a kid is a node or a string. Namespaces are kept in the names ("text:p").
function parseXml(text) {
  const root = { name: '#root', attrs: {}, kids: [] }
  const stack = [root]
  const pattern = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*(?:\[[\s\S]*?\])?>|<(\/?)([^\s/>]+)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>|([^<]+)/g
  let found
  while ((found = pattern.exec(text))) {
    const top = stack[stack.length - 1]
    if (found[1] !== undefined) top.kids.push(found[1])                                    // (a CDATA section)
    else if (found[6] !== undefined) top.kids.push(decodeEntities(found[6]))               // (words)
    else if (found[3] !== undefined) {                                                     // (a tag: found[2] is the "/" of a closing tag, found[5] the "/" of an empty one)
      if (found[2] === '/') { if (stack.length > 1) stack.pop() } else {
        const attrs = {}
        for (const one of found[4].matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[one[1]] = decodeEntities(one[2] !== undefined ? one[2] : one[3])
        const node = { name: found[3], attrs, kids: [] }
        top.kids.push(node)
        if (!found[5]) stack.push(node)
      }
    }
  }
  return root
}

// A web page (or a chapter of a book) as markdown. `hooks.image(src, alt)` answers the markdown for a picture (or '' to leave it out) and may take its time; `hooks.link(href)` answers the address
// a link should have, or null when only its words should stay. Headings, emphasis, strike-through, bullet and numbered lists, quotes, code, tables, rules and breaks come across.
async function htmlToMarkdown(html, hooks) {
  html = html.replace(/<\?xml[\s\S]*?\?>|<!DOCTYPE[\s\S]*?>|<!--[\s\S]*?-->|<head\b[\s\S]*?<\/head>|<script\b[\s\S]*?<\/script>|<style\b[\s\S]*?<\/style>|<noscript\b[\s\S]*?<\/noscript>|<svg\b[\s\S]*?<\/svg>|<nav\b[\s\S]*?<\/nav>/gi, '')
  const body = /<body\b[^>]*>([\s\S]*)<\/body>/i.exec(html)
  html = body ? body[1] : html
  const pictures = new Map()
  for (const tag of html.match(/<img\b[^>]*>/gi) || []) {
    const source = attribute(tag, 'src')
    if (source && !pictures.has(source)) pictures.set(source, await hooks.image(decodeEntities(source), decodeEntities(attribute(tag, 'alt') || '')))
  }
  const out = []
  let line = ''
  let prefix = ''
  let quote = 0
  const lists = []
  let hold = null
  let table = null
  let pre = null
  let kept = ''
  const marks = []
  const isItem = () => /^(\s*)(- |\d+\. )/.test(prefix)
  const flush = () => {
    const words = line.replace(/[ \t]+\n/g, '\n').trim()
    line = ''
    if (!words) { prefix = ''; return }
    const lead = '> '.repeat(quote) + prefix
    const block = words.split('\n').map((part, i) => (i === 0 ? lead : '> '.repeat(quote) + ' '.repeat(prefix.length)) + part).join('\n')
    out.push((kept === 'item' && isItem() ? '\n' : '\n\n') + block)
    kept = isItem() ? 'item' : 'block'
    prefix = ''
  }
  const add = (value) => { if (hold !== null) hold += value; else line += value }
  const pattern = /<(\/?)([a-zA-Z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>|([^<]+)/g
  let found
  while ((found = pattern.exec(html))) {
    if (found[5] !== undefined) {
      const value = decodeEntities(found[5])
      if (pre !== null) pre += value
      else add(escapeText(value.replace(/\s+/g, ' ')))
      continue
    }
    const closing = found[1] === '/'
    const tag = found[2].toLowerCase().replace(/^\w+:/, '')
    const attrs = found[3]
    if (pre !== null) { if (closing && tag === 'pre') { out.push('\n\n```\n' + pre.replace(/\n+$/, '') + '\n```'); kept = 'block'; pre = null } else if (tag === 'br') pre += '\n'; continue }
    if (/^h[1-6]$/.test(tag)) { flush(); if (!closing) prefix = '#'.repeat(Number(tag[1])) + ' '; else flush(); continue }
    switch (tag) {
      case 'p': case 'div': case 'section': case 'article': case 'figure': case 'figcaption': case 'header': case 'footer': case 'aside': case 'main': case 'dd': case 'dt': flush(); break
      case 'br': add(hold !== null ? ' ' : '  \n'); break
      case 'hr': flush(); out.push('\n\n---'); kept = 'block'; break
      case 'blockquote': flush(); quote = Math.max(0, quote + (closing ? -1 : 1)); break
      case 'ul': case 'ol': flush(); if (closing) lists.pop(); else lists.push({ ordered: tag === 'ol', count: 0 }); if (!lists.length) kept = 'block'; break
      case 'li':
        flush()
        if (!closing && lists.length) { const list = lists[lists.length - 1]; list.count += 1; prefix = '    '.repeat(lists.length - 1) + (list.ordered ? `${list.count}. ` : '- ') }
        break
      case 'pre': if (!closing) { flush(); pre = '' } break
      case 'strong': case 'b': add('**'); break
      case 'em': case 'i': add('*'); break
      case 'del': case 's': case 'strike': add('~~'); break
      case 'code': add('`'); break
      case 'a':
        if (!closing) {
          const target = hooks.link(decodeEntities(attribute(attrs, 'href') || ''))
          marks.push(target || null)
          add(target ? '[' : '')
        } else {
          const target = marks.pop()
          add(target ? `](${String(target).replace(/\)/g, '%29').replace(/ /g, '%20')})` : '')
        }
        break
      case 'img': { const picture = pictures.get(attribute(attrs, 'src')); if (picture) add(picture); break }
      case 'table': if (!closing) { flush(); table = [] } else if (table) { const width = Math.max(1, ...table.map((row) => row.length)); const rows = table.map((row) => row.concat(Array(width - row.length).fill(''))); out.push('\n\n| ' + rows[0].join(' | ') + ' |\n|' + ' --- |'.repeat(width) + rows.slice(1).map((row) => '\n| ' + row.join(' | ') + ' |').join('')); kept = 'block'; table = null } break
      case 'tr': if (table && !closing) table.push([]); break
      case 'td': case 'th': if (table && table.length) { if (!closing) hold = ''; else { table[table.length - 1].push(hold.trim().replace(/\|/g, '\\|')); hold = null } } break
      default: break
    }
  }
  flush()
  return out.join('').replace(/\n{3,}/g, '\n\n').trim()
}

// A CSV file as rows of words (quotes, doubled quotes, commas or semicolons or tabs, any line ending).
function csvRows(text) {
  const first = text.split(/\r?\n/, 1)[0]
  const separator = [',', ';', '\t'].map((s) => [s, first.split(s).length]).sort((a, b) => b[1] - a[1])[0][0]
  const rows = []
  let row = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i]
    if (quoted) { if (c === '"' && text[i + 1] === '"') { cell += '"'; i += 1 } else if (c === '"') quoted = false; else cell += c } else if (c === '"') quoted = true
    else if (c === separator) { row.push(cell); cell = '' } else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i += 1; row.push(cell); rows.push(row); row = []; cell = '' } else cell += c
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row) }
  return rows.filter((r) => r.some((c) => c.trim() !== ''))
}

// Rows of words as a markdown table (the first row is the heading).
function markdownTable(rows) {
  if (!rows.length) return ''
  const width = Math.max(...rows.map((r) => r.length))
  const cells = rows.map((r) => r.concat(Array(width - r.length).fill('')).map((c) => c.replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' <br> ').trim()))
  return '| ' + cells[0].join(' | ') + ' |\n|' + ' --- |'.repeat(width) + cells.slice(1).map((r) => '\n| ' + r.join(' | ') + ' |').join('')
}

// The properties block at the top of a note: tags, and what else is known.
function propertiesBlock(properties) {
  const lines = []
  for (const [key, value] of Object.entries(properties)) {
    if (Array.isArray(value) ? !value.length : !String(value || '').trim()) continue
    lines.push(Array.isArray(value) ? `${key}: [${value.map((v) => JSON.stringify(String(v))).join(', ')}]` : `${key}: ${JSON.stringify(String(value))}`)
  }
  return lines.length ? `---\n${lines.join('\n')}\n---\n\n` : ''
}

// The folder part and the file part of a path in a zip.
function pathParts(path) {
  const parts = path.split('/')
  return { folder: parts.slice(0, -1), file: parts[parts.length - 1] }
}

// ── EPUB books ──────────────────────────────────────────────────────────────────────────────────
const epub = {
  id: 'epub', title: 'EPUB book to a note', extensions: ['.epub'], files: 'EPUB books',
  async convert(file) {
    const zip = await unzip(file.bytes)
    const PICTURES = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg']
    const encryption = await zip.text('META-INF/encryption.xml')
    if (encryption && /Algorithm="(?!http:\/\/www\.idpf\.org\/2008\/embedding|http:\/\/ns\.adobe\.com\/pdf\/enc#RC)/.test(encryption)) throw new Error('This book is protected (DRM) and cannot be read.')
    const container = await zip.text('META-INF/container.xml')
    const rootfile = container && /full-path\s*=\s*["']([^"']+)["']/.exec(container)
    if (!rootfile) throw new Error('This is not an EPUB book (it has no package file).')
    const opfPath = rootfile[1]
    const opf = await zip.text(opfPath)
    if (!opf) throw new Error('This book has no package file.')
    const resolve = (base, href) => {
      const out = base.split('/').slice(0, -1).filter(Boolean)
      for (const piece of decodeURIComponent(href.split('#')[0]).split('/')) { if (piece === '..') out.pop(); else if (piece && piece !== '.') out.push(piece) }
      return out.join('/')
    }
    const manifest = new Map()
    for (const tag of opf.match(/<(?:\w+:)?item\b[^>]*>/g) || []) manifest.set(attribute(tag, 'id'), { href: attribute(tag, 'href'), properties: attribute(tag, 'properties') || '' })
    const order = []
    for (const tag of opf.match(/<(?:\w+:)?itemref\b[^>]*>/g) || []) {
      const item = manifest.get(attribute(tag, 'idref'))
      if (item && item.href && !/\bnav\b/.test(item.properties)) order.push(resolve(opfPath, item.href))          // (the book's own contents page is left out: the headings are in the text)
    }
    const metadata = (name) => { const found = new RegExp(`<dc:${name}\\b[^>]*>([\\s\\S]*?)</dc:${name}>`).exec(opf); return found ? decodeEntities(found[1].replace(/<[^>]+>/g, '')).trim() : '' }
    const images = {}
    const keys = new Map()
    const skipped = { pictures: 0, links: 0 }
    let chapter = ''
    const hooks = {
      image: async (source, alt) => {
        const path = resolve(chapter, source)
        if (!keys.has(path)) {
          const suffix = (path.match(/\.[^./]*$/) || [''])[0].toLowerCase()
          const data = PICTURES.includes(suffix) ? await zip.read(path) : null
          if (!data) { skipped.pictures += 1; keys.set(path, null) } else { const key = `i${Object.keys(images).length + 1}`; images[key] = { name: path.split('/').pop(), bytes: data }; keys.set(path, key) }
        }
        return keys.get(path) ? `![${alt.replace(/[\]\n]/g, ' ')}](image:${keys.get(path)})` : ''
      },
      link: (href) => { if (/^(https?:|mailto:)/i.test(href)) return href; if (href) skipped.links += 1; return null },
    }
    let markdown = ''
    for (const path of order) {
      const html = await zip.text(path)
      if (!html) continue
      chapter = path
      markdown += '\n\n' + await htmlToMarkdown(html, hooks)
    }
    markdown = markdown.replace(/\n{3,}/g, '\n\n').trim()
    const title = metadata('title') || file.name.replace(/\.[^.]*$/, '')
    const author = metadata('creator')
    if (!markdown.startsWith('#')) markdown = `# ${title}\n\n${author ? `*${author}*\n\n` : ''}${markdown}`
    const report = []
    if (skipped.links) report.push(`${skipped.links} link${skipped.links === 1 ? '' : 's'} inside the book ${skipped.links === 1 ? 'was' : 'were'} turned into plain words.`)
    if (skipped.pictures) report.push(`${skipped.pictures} picture${skipped.pictures === 1 ? '' : 's'} ${skipped.pictures === 1 ? 'was' : 'were'} left out (a kind the page cannot show, or not in the book).`)
    if (!markdown.replace(/^#.*$/m, '').trim()) report.push('There were no words in it.')
    return { notes: [{ name: title, markdown, images }], report }
  },
}

// ── OpenDocument text (.odt) ────────────────────────────────────────────────────────────────────
const odt = {
  id: 'odt', title: 'OpenDocument text to a note', extensions: ['.odt', '.ott'], files: 'OpenDocument text files',
  async convert(file) {
    const zip = await unzip(file.bytes)
    const content = await zip.text('content.xml')
    if (!content) throw new Error('This is not an OpenDocument text file (it has no content.xml).')
    const tree = parseXml(content)
    const first = (node, name) => { for (const kid of node.kids) { if (typeof kid !== 'string') { if (kid.name === name) return kid; const deeper = first(kid, name); if (deeper) return deeper } } return null }
    const all = (node, name, out = []) => { for (const kid of node.kids) if (typeof kid !== 'string') { if (kid.name === name) out.push(kid); all(kid, name, out) } return out }
    // how a named style looks (bold, italic, ...) and which list styles count (numbers or bullets)
    const looks = {}
    const listKinds = {}
    for (const style of all(tree, 'style:style')) {
      const props = style.kids.find((k) => typeof k !== 'string' && k.name === 'style:text-properties')
      if (!props) continue
      const a = props.attrs
      looks[style.attrs['style:name']] = {
        bold: a['fo:font-weight'] === 'bold' || a['fo:font-weight'] >= 600, italic: a['fo:font-style'] === 'italic',
        strike: !!a['style:text-line-through-style'] && a['style:text-line-through-style'] !== 'none',
        underline: !!a['style:text-underline-style'] && a['style:text-underline-style'] !== 'none', color: !!a['fo:color'] && a['fo:color'] !== '#000000',
      }
    }
    for (const list of all(tree, 'text:list-style')) listKinds[list.attrs['style:name']] = list.kids.some((k) => typeof k !== 'string' && k.name === 'text:list-level-style-number') ? 'number' : 'bullet'
    const images = {}
    const skipped = { pictures: 0, notes: 0, comments: 0, formatting: false }
    const inline = async (node) => {
      let out = ''
      for (const kid of node.kids) {
        if (typeof kid === 'string') { out += escapeText(kid); continue }
        switch (kid.name) {
          case 'text:span': {
            const look = looks[kid.attrs['text:style-name']] || {}
            if (look.underline || look.color) skipped.formatting = true
            let text = await inline(kid)
            if (text.trim()) {
              const parts = /^(\s*)([\s\S]*?)(\s*)$/.exec(text)
              let core = parts[2]
              if (look.strike) core = `~~${core}~~`
              if (look.bold && look.italic) core = `***${core}***`; else if (look.bold) core = `**${core}**`; else if (look.italic) core = `*${core}*`
              text = parts[1] + core + parts[3]
            }
            out += text
            break
          }
          case 'text:a': {
            const href = kid.attrs['xlink:href'] || ''
            const text = await inline(kid)
            out += /^(https?:|mailto:)/i.test(href) && text.trim() ? `[${text.trim()}](${href.replace(/ /g, '%20')})` : text
            break
          }
          case 'text:line-break': out += '  \n'; break
          case 'text:tab': out += '    '; break
          case 'text:s': out += ' '.repeat(Number(kid.attrs['text:c'] || 1)); break
          case 'draw:frame': {
            const image = first(kid, 'draw:image')
            const href = image && image.attrs['xlink:href']
            const data = href && !/^(https?:)/i.test(href) ? await zip.read(href) : null
            const suffix = href ? (href.match(/\.[^./]*$/) || [''])[0].toLowerCase() : ''
            if (data && ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg'].includes(suffix)) { const key = `i${Object.keys(images).length + 1}`; images[key] = { name: href.split('/').pop(), bytes: data }; out += `![](image:${key})` } else skipped.pictures += 1
            break
          }
          case 'text:note': skipped.notes += 1; break
          case 'office:annotation': skipped.comments += 1; break
          case 'text:soft-page-break': case 'text:bookmark': case 'text:bookmark-start': case 'text:bookmark-end': case 'text:sequence-decls': case 'office:annotation-end': break
          default: if (kid.name.startsWith('text:')) out += await inline(kid)
        }
      }
      return out.replace(/\*\*\*\*|~~~~/g, '')
    }
    const blocks = []
    const push = (text) => { if (text !== '') blocks.push(text) }
    const walk = async (node, depth, kind, counters = { n: 0 }) => {
      for (const kid of node.kids) {
        if (typeof kid === 'string') continue
        if (kid.name === 'text:h') push(`${'#'.repeat(Math.min(6, Number(kid.attrs['text:outline-level'] || 1)))} ${(await inline(kid)).trim()}`)
        else if (kid.name === 'text:p') { const text = (await inline(kid)).trim(); push(depth ? `${'    '.repeat(depth - 1)}${kind === 'number' ? `${counters.n += 1}. ` : '- '}${text}` : text) }
        else if (kid.name === 'text:list') await walk(kid, depth + 1, listKinds[kid.attrs['text:style-name']] || kind || 'bullet', { n: 0 })
        else if (kid.name === 'text:list-item' || kid.name === 'text:list-header') await walk(kid, depth, kind, counters)
        else if (kid.name === 'table:table') {
          const rows = []
          for (const row of all(kid, 'table:table-row')) {
            const cells = []
            for (const cell of row.kids) if (typeof cell !== 'string' && cell.name === 'table:table-cell') { const words = []; for (const p of cell.kids) if (typeof p !== 'string' && (p.name === 'text:p' || p.name === 'text:h')) words.push((await inline(p)).trim()); cells.push(words.filter(Boolean).join(' <br> ')) } else if (typeof cell !== 'string' && cell.name === 'table:covered-table-cell') cells.push('')
            rows.push(cells)
          }
          if (rows.length) push(markdownTable(rows))
        } else if (['text:section', 'office:text', 'text:index-body', 'text:table-of-content', 'text:table-of-content-source'].includes(kid.name)) { if (kid.name !== 'text:table-of-content-source') await walk(kid, depth, kind) }
      }
    }
    const body = first(tree, 'office:text')
    if (!body) throw new Error('This is not an OpenDocument text file (it has no text).')
    await walk(body, 0, '')
    // blocks stand apart, but the items of a list stand together
    let markdown = ''
    const sort = (block) => (/^\s*- /.test(block) ? '-' : /^\s*\d+\. /.test(block) ? '1' : '')
    blocks.forEach((block, i) => { markdown += (i === 0 ? '' : sort(block) && sort(block) === sort(blocks[i - 1]) ? '\n' : '\n\n') + block })
    const report = []
    if (skipped.notes) report.push(`${skipped.notes} footnote${skipped.notes === 1 ? '' : 's'} or endnote${skipped.notes === 1 ? '' : 's'} left out.`)
    if (skipped.comments) report.push(`${skipped.comments} comment${skipped.comments === 1 ? ' was' : 's were'} left out.`)
    if (skipped.pictures) report.push(`${skipped.pictures} picture${skipped.pictures === 1 ? ' was' : 's were'} left out (drawings, charts, or a kind the page cannot show).`)
    if (skipped.formatting) report.push('Underline and colors do not come across.')
    if (!markdown.trim()) report.push('There were no words in it.')
    return { notes: [{ name: file.name.replace(/\.[^.]*$/, ''), markdown, images }], report }
  },
}

// ── Rich Text (.rtf) ────────────────────────────────────────────────────────────────────────────
const rtf = {
  id: 'rtf', title: 'Rich Text file to a note', extensions: ['.rtf'], files: 'Rich Text files',
  async convert(file) {
    let src = ''
    for (let i = 0; i < file.bytes.length; i += 0x8000) src += String.fromCharCode.apply(null, file.bytes.subarray(i, i + 0x8000))      // (the bytes, one to a character: the file is 7-bit text with escapes)
    if (!/^\s*\{\\rtf/.test(src)) throw new Error('This is not a Rich Text file.')
    const labels = { 1250: 'windows-1250', 1251: 'windows-1251', 1252: 'windows-1252', 1253: 'windows-1253', 1254: 'windows-1254', 1255: 'windows-1255', 1256: 'windows-1256', 1257: 'windows-1257', 1258: 'windows-1258', 874: 'windows-874', 932: 'shift_jis', 936: 'gbk', 949: 'euc-kr', 950: 'big5', 65001: 'utf-8', 10000: 'macintosh' }
    let label = 'windows-1252'
    const SKIP = new Set(['fonttbl', 'colortbl', 'info', 'listtable', 'listoverridetable', 'generator', 'xmlnstbl', 'rsidtbl', 'header', 'headerl', 'headerr', 'headerf', 'footer', 'footerl', 'footerr', 'footerf', 'themedata', 'colorschememapping', 'datastore', 'latentstyles', 'filetbl', 'revtbl', 'pgptbl', 'bkmkstart', 'bkmkend', 'objdata', 'private', 'userprops', 'mmathPr'])
    const marks = { emdash: '—', endash: '–', lquote: '‘', rquote: '’', ldblquote: '“', rdblquote: '”', bullet: '•', enspace: ' ', emspace: ' ', qmspace: ' ' }
    const images = {}
    const skipped = { pictures: 0, notes: 0, headers: 0, formatting: false }
    const styles = {}
    const blocks = []
    let rows = []
    let cells = []
    let runs = ''
    let para = { style: 0, list: null, depth: 0, inTable: false, marker: '' }
    let st = { b: false, i: false, u: false, s: false, uc: 1, dest: '', skip: false }
    const stack = []
    let bytes = []
    let skipChars = 0
    let styleId = 0
    let styleName = ''
    let pict = null
    let fieldLink = null
    let linkStart = -1
    let ignorable = false
    const flushBytes = () => { if (bytes.length) { let words = ''; try { words = new TextDecoder(label).decode(Uint8Array.from(bytes)) } catch (e) { words = String.fromCharCode(...bytes) } bytes = []; put(words) } }
    const put = (text) => {
      if (st.skip && st.dest !== 'pntext') return
      if (st.dest === 'stylesheet') { for (const c of text) { if (c === ';') { if (styleId) styles[styleId] = styleName.trim().toLowerCase(); styleName = '' } else styleName += c } return }
      if (st.dest === 'pntext') { para.marker += text; return }
      if (st.dest === 'fldinst') { fieldLink = (fieldLink || '') + text; return }
      if (st.dest === 'pict') return
      const lead = /^\s*/.exec(text)[0]
      const tail = /\s*$/.exec(text)[0]
      let core = text.trim()
      if (!core) { runs += text; return }
      {
        core = escapeText(core)
        if (st.s) core = `~~${core}~~`
        if (st.b && st.i) core = `***${core}***`; else if (st.b) core = `**${core}**`; else if (st.i) core = `*${core}*`
        if (st.u && st.dest !== 'fldrslt') skipped.formatting = true             // (a link is underlined: that is not something lost)
      }
      runs += lead + core + tail
    }
    const tidy = (text) => text.replace(/\*\*\*\*|~~~~|\*\* \*\*/g, (m) => (m === '** **' ? ' ' : '')).replace(/[ \t]+\n/g, '\n')
    const endPara = () => {
      flushBytes()
      if (para.inTable) { runs += runs.trim() ? ' <br> ' : ''; return }
      if (rows.length) { blocks.push(markdownTable(rows)); rows = [] }
      const text = tidy(runs).trim()
      const name = styles[para.style] || ''
      runs = ''
      const marker = para.marker.trim()
      para.marker = ''
      if (!text) { blocks.push(''); return }
      const heading = /^heading (\d)/.exec(name)
      if (heading) blocks.push(`${'#'.repeat(Number(heading[1]))} ${text}`)
      else if (name === 'title') blocks.push(`# ${text}`)
      else if (para.list !== null || marker) blocks.push(`${'    '.repeat(para.depth)}${/^(\d+|[a-zA-Z]|[ivxlcdmIVXLCDM]+)[.)]/.test(marker) ? '1. ' : '- '}${text.replace(/\n/g, ' ')}`)
      else blocks.push(text)
    }
    const controlWord = (word, number) => {
      switch (word) {
        case 'par': case 'sect': case 'page': endPara(); break
        case 'line': put('\n'); runs += '  \n'; runs = runs.replace(/\n  \n$/, '  \n'); break
        case 'tab': put('    '); break
        case 'cell': flushBytes(); cells.push(tidy(runs).trim().replace(/\|/g, '\\|')); runs = ''; break
        case 'row': flushBytes(); rows.push(cells); cells = []; para.inTable = false; break
        case 'trowd': para.inTable = true; break
        case 'intbl': para.inTable = true; break
        case 'pard': para = { style: 0, list: null, depth: 0, inTable: para.inTable && rows.length === 0 && cells.length > 0, marker: '' }; break
        case 'plain': st.b = st.i = st.u = st.s = false; break
        case 'b': st.b = number !== 0; break
        case 'i': st.i = number !== 0; break
        case 'ul': case 'uld': case 'uldb': case 'ulw': st.u = number !== 0; break
        case 'ulnone': st.u = false; break
        case 'strike': case 'striked': st.s = number !== 0; break
        case 's': if (st.dest === 'stylesheet') styleId = number; else para.style = number; break
        case 'ls': para.list = number; break
        case 'ilvl': para.depth = Math.min(number || 0, 6); break
        case 'cf': case 'highlight': case 'cb': if (number) skipped.formatting = true; break
        case 'uc': st.uc = number === undefined ? 1 : number; break
        case 'ansicpg': label = labels[number] || 'windows-1252'; break
        case 'mac': label = 'macintosh'; break
        case 'pntext': case 'listtext': st.dest = 'pntext'; break
        case 'stylesheet': st.dest = 'stylesheet'; st.skip = false; break
        case 'pict': st.dest = 'pict'; pict = { kind: '', hex: '' }; break
        case 'pngblip': if (pict) pict.kind = '.png'; break
        case 'jpegblip': if (pict) pict.kind = '.jpg'; break
        case 'wmetafile': case 'emfblip': case 'dibitmap': case 'wbitmap': case 'macpict': if (pict) pict.kind = 'no'; break
        case 'footnote': skipped.notes += 1; st.skip = true; break
        case 'fldinst': st.dest = 'fldinst'; break
        case 'fldrslt': st.dest = 'fldrslt'; linkStart = runs.length; break
        default:
          if (marks[word]) put(marks[word])
          else if (SKIP.has(word)) { st.skip = true; if (/^(header|footer)/.test(word)) skipped.headers += 1 }
      }
    }
    const n = src.length
    for (let i = 0; i < n;) {
      const c = src[i]
      if (c === '{') { flushBytes(); stack.push({ ...st }); i += 1; ignorable = false; continue }
      if (c === '}') {
        flushBytes()
        if (st.dest === 'pict' && pict) {
          if (pict.kind && pict.kind !== 'no' && pict.hex.length > 2) {
            const data = new Uint8Array(Math.floor(pict.hex.length / 2))
            for (let k = 0; k < data.length; k += 1) data[k] = parseInt(pict.hex.substr(k * 2, 2), 16)
            const key = `i${Object.keys(images).length + 1}`
            images[key] = { name: `picture${pict.kind}`, bytes: data }
            runs += `![](image:${key})`
          } else skipped.pictures += 1
          pict = null
        }
        if (st.dest === 'fldrslt' && fieldLink !== null && linkStart >= 0) {
          const url = /HYPERLINK\s+"([^"]+)"/i.exec(fieldLink)
          const shown = runs.slice(linkStart)
          if (url && /^(https?:|mailto:)/i.test(url[1]) && shown.trim()) runs = runs.slice(0, linkStart) + `[${shown.trim()}](${url[1].replace(/ /g, '%20')})`
          fieldLink = null
          linkStart = -1
        }
        const was = st.dest
        st = stack.pop() || st
        if (was === 'pntext' && st.dest !== 'pntext') { /* the marker is kept in para.marker */ }
        i += 1
        continue
      }
      if (c === '\\') {
        const next = src[i + 1]
        if (next === '\\' || next === '{' || next === '}') { put(next); i += 2; continue }
        if (next === '\n' || next === '\r') { endPara(); i += 2; continue }
        if (next === '*') { ignorable = true; i += 2; continue }
        if (next === "'") {
          const value = parseInt(src.substr(i + 2, 2), 16)
          i += 4
          if (skipChars > 0) { skipChars -= 1; continue }
          if (!st.skip || st.dest === 'pntext') bytes.push(Number.isNaN(value) ? 63 : value)
          continue
        }
        if (next === '~') { flushBytes(); put(' '); i += 2; continue }
        if (next === '-' || next === '_') { i += 2; continue }
        const word = /^\\([a-zA-Z]+)(-?\d+)? ?/.exec(src.slice(i, i + 40))
        if (!word) { i += 2; continue }
        i += word[0].length
        const number = word[2] === undefined ? undefined : Number(word[2])
        if (word[1] === 'u' && number !== undefined) {
          flushBytes()
          const code = number < 0 ? number + 65536 : number
          if (skipChars > 0) skipChars = 0
          if (!st.skip || st.dest === 'pntext') put(String.fromCharCode(code))
          skipChars = st.uc
          continue
        }
        if (word[1] === 'bin' && number) { i += number; continue }
        const known = ignorable && (word[1] === 'fldinst' || word[1] === 'pn' || word[1] === 'pntext')
        if (ignorable && !known && !['listtext'].includes(word[1])) { st.skip = true; ignorable = false; continue }
        ignorable = false
        flushBytes()
        controlWord(word[1], number)
        continue
      }
      if (c === '\r' || c === '\n') { i += 1; continue }
      let j = i
      while (j < n && src[j] !== '\\' && src[j] !== '{' && src[j] !== '}' && src[j] !== '\r' && src[j] !== '\n') j += 1
      const chunk = src.slice(i, j)
      i = j
      if (st.dest === 'pict') { if (pict) pict.hex += chunk.replace(/[^0-9a-fA-F]/g, ''); continue }
      if (skipChars > 0) { const cut = Math.min(skipChars, chunk.length); skipChars -= cut; if (cut === chunk.length) continue; put(chunk.slice(cut)); continue }
      let plain = ''
      for (const ch of chunk) { if (ch.charCodeAt(0) >= 0x80) { if (plain) { put(plain); plain = '' } bytes.push(ch.charCodeAt(0)) } else { if (bytes.length) { flushBytes() } plain += ch } }
      if (plain) put(plain)
    }
    flushBytes()
    endPara()
    if (rows.length) blocks.push(markdownTable(rows))
    let markdown = ''
    const sort = (block) => (block && /^\s*- /.test(block) ? '-' : block && /^\s*\d+\. /.test(block) ? '1' : '')
    blocks.forEach((block, k) => { if (block === '') return; markdown += (markdown === '' ? '' : sort(block) && sort(block) === sort(blocks[k - 1]) ? '\n' : '\n\n') + block })
    const report = []
    if (skipped.notes) report.push(`${skipped.notes} footnote${skipped.notes === 1 ? '' : 's'} left out.`)
    if (skipped.headers) report.push('The headers and footers were left out.')
    if (skipped.pictures) report.push(`${skipped.pictures} picture${skipped.pictures === 1 ? ' was' : 's were'} left out (a kind the page cannot show).`)
    if (skipped.formatting) report.push('Underline, colors and highlights do not come across.')
    if (!markdown.trim()) report.push('There were no words in it.')
    return { notes: [{ name: file.name.replace(/\.[^.]*$/, ''), markdown, images }], report }
  },
}

// ── web pages (.html) ───────────────────────────────────────────────────────────────────────────
const html = {
  id: 'html', title: 'Web page to a note', extensions: ['.html', '.htm'], files: 'web pages',
  async convert(file) {
    const page = decodeText(file.bytes)
    const images = {}
    const skipped = { pictures: 0 }
    const hooks = {
      image: (source, alt) => {
        const data = /^data:image\/(png|jpe?g|gif|webp|bmp|svg\+xml);base64,([A-Za-z0-9+/=\s]+)$/i.exec(source)
        if (!data) { skipped.pictures += 1; return '' }                              // (a picture that is a file of its own, or on the web: not part of this one file)
        const binary = atob(data[2].replace(/\s/g, ''))
        const bytes = new Uint8Array(binary.length)
        for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
        const key = `i${Object.keys(images).length + 1}`
        images[key] = { name: `picture.${data[1].toLowerCase().replace('jpeg', 'jpg').replace('svg+xml', 'svg')}`, bytes }
        return `![${alt.replace(/[\]\n]/g, ' ')}](image:${key})`
      },
      link: (href) => (/^(https?:|mailto:)/i.test(href) ? href : null),
    }
    let markdown = await htmlToMarkdown(page, hooks)
    const title = (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(page) || [, ''])[1]
    const heading = /^#{1,6} (.+)$/m.exec(markdown)
    const name = decodeEntities(title.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim() || (heading ? heading[1] : file.name.replace(/\.[^.]*$/, ''))
    if (title.trim() && !markdown.startsWith('#')) markdown = `# ${name}\n\n${markdown}`
    const report = []
    if (skipped.pictures) report.push(`${skipped.pictures} picture${skipped.pictures === 1 ? ' is' : 's are'} not in the page itself (files of their own, or on the web), so ${skipped.pictures === 1 ? 'it was' : 'they were'} left out.`)
    if (!markdown.trim()) report.push('There were no words in it.')
    return { notes: [{ name, markdown, images }], report }
  },
}

// ── a Notion export (.zip): "Export as Markdown & CSV" ──────────────────────────────────────────
// The notes keep their folders (a page's sub-pages are in a folder of its name), the long ids Notion puts at the end of every name are taken off, the links between pages stay links, pictures
// come along, and a database (a .csv) becomes a note with a table.
const notion = {
  id: 'notion', title: 'Notion export to notes', extensions: ['.zip'], files: 'Notion exports',
  async convert(file) {
    const entries = []
    const gather = async (zip, depth) => {
      for (const name of zip.names) {
        if (/^__MACOSX\//.test(name) || /(^|\/)\.DS_Store$/.test(name)) continue
        if (/\.zip$/i.test(name) && depth < 2) await gather(await unzip(await zip.read(name)), depth + 1)      // (a newer export holds another zip inside)
        else entries.push({ zip, name })
      }
    }
    await gather(await unzip(file.bytes), 0)
    const pages = entries.filter((e) => /\.md$/i.test(e.name))
    const tables = entries.filter((e) => /\.csv$/i.test(e.name))
    if (!pages.length && !tables.length) throw new Error('This zip file does not look like a Notion export (it has no .md or .csv files).')
    const stripId = (part) => part.replace(/ [0-9a-f]{32}(?=\.|$)/i, '')
    const top = new Set(entries.map((e) => e.name.split('/')[0]))
    const dropTop = top.size === 1 && /^(Export-|ExportBlock-)/.test([...top][0]) && entries.every((e) => e.name.includes('/'))
    const placeOf = (zipPath, isFile) => {
      const parts = zipPath.split('/').slice(dropTop ? 1 : 0)
      const last = parts.pop()
      return { folder: parts.map(stripId), name: stripId(isFile ? last.replace(/\.[^.]*$/, '') : last) }
    }
    const used = new Set()
    const planned = new Map()                                                        // the zip's path -> where the note will be in the plan
    const keyOf = (folder, name) => `${folder.join('/')}/${name}`.toLowerCase()
    const claim = (zipPath, isFile, suffix = '') => {
      const place = placeOf(zipPath, isFile)
      let name = place.name + suffix
      let n = 2
      while (used.has(keyOf(place.folder, name))) { name = `${place.name}${suffix} ${n}`; n += 1 }
      used.add(keyOf(place.folder, name))
      planned.set(zipPath, { folder: place.folder.join('/'), name })
      return planned.get(zipPath)
    }
    for (const page of pages) claim(page.name, true)
    const bestTables = tables.filter((t) => !(/_all\.csv$/i.test(t.name) === false && tables.some((o) => o.name === t.name.replace(/\.csv$/i, '_all.csv'))))      // (a database comes twice: the "_all" one has every column)
    for (const table of bestTables) claim(table.name.replace(/_all\.csv$/i, '.csv'), true)
    const byPath = new Map(entries.map((e) => [e.name, e]))
    const normalise = (base, href) => {
      const out = base.split('/').slice(0, -1)
      let target = href
      try { target = decodeURIComponent(href.split('#')[0]) } catch (e) { target = href.split('#')[0] }
      for (const piece of target.split('/')) { if (piece === '..') out.pop(); else if (piece && piece !== '.') out.push(piece) }
      return out.join('/')
    }
    const stats = { pages: 0, tables: 0, links: 0, pictures: 0, files: 0, boxes: 0 }
    const notes = []
    const IMAGE = /\.(png|jpe?g|gif|webp|bmp|svg)$/i
    const planAddress = (p) => `${p.folder ? p.folder + '/' : ''}${p.name}.md`.replace(/ /g, '%20').replace(/\)/g, '%29')
    for (const page of pages) {
      const where = planned.get(page.name)
      let text = (await page.zip.text(page.name)).replace(/^﻿/, '')
      const images = {}
      const keys = new Map()
      const parts = text.split(/(^```[\s\S]*?^```)/m)                                  // (code blocks are left as they are)
      for (let k = 0; k < parts.length; k += 2) {
        parts[k] = parts[k].replace(/(!?)\[([^\]]*)\]\(((?:[^()\s]|\([^)]*\))+?)\)/g, (whole, bang, label, href) => {
          if (/^(https?:|mailto:|tel:)/i.test(href)) return whole
          const target = normalise(page.name, href)
          if (bang) {
            const entry = byPath.get(target)
            if (entry && IMAGE.test(target)) {
              if (!keys.has(target)) { const key = `i${Object.keys(images).length + 1}`; images[key] = { name: target.split('/').pop(), read: entry }; keys.set(target, key) }
              return `![${label}](image:${keys.get(target)})`
            }
            stats.pictures += 1
            return ''
          }
          const found = planned.get(target) || planned.get(target.replace(/\.csv$/i, '.csv'))
          if (found) return `[${label}](import:${planAddress(found)})`
          if (byPath.has(target)) { stats.files += 1; return label }
          stats.links += 1
          return label
        })
        parts[k] = parts[k].replace(/<aside>\s*([\s\S]*?)\s*<\/aside>/g, (_m, inner) => { stats.boxes += 1; return inner.trim().split('\n').map((l) => `> ${l}`).join('\n') })
          .replace(/<\/?details>|<\/?summary>/g, '').replace(/<br\s*\/?>/gi, '  \n')
      }
      text = parts.join('').trim()
      for (const key of Object.keys(images)) { const bytes = await images[key].read.zip.read(images[key].read.name); images[key] = { name: images[key].name, bytes } }
      stats.pages += 1
      notes.push({ name: where.name, folder: where.folder, markdown: text, images })
    }
    for (const table of bestTables) {
      const where = planned.get(table.name.replace(/_all\.csv$/i, '.csv'))
      const rows = csvRows((await table.zip.text(table.name)).replace(/^﻿/, ''))
      if (!rows.length) continue
      stats.tables += 1
      notes.push({ name: where.name, folder: where.folder, markdown: `# ${where.name}\n\n${markdownTable(rows)}`, images: {} })
    }
    const report = []
    report.push(`${stats.pages} page${stats.pages === 1 ? '' : 's'}${stats.tables ? ` and ${stats.tables} database${stats.tables === 1 ? '' : 's'} (as tables)` : ''} came across, in the folders they were in.`)
    if (stats.links) report.push(`${stats.links} link${stats.links === 1 ? '' : 's'} to pages that are not in this export ${stats.links === 1 ? 'was' : 'were'} turned into plain words.`)
    if (stats.files) report.push(`${stats.files} link${stats.files === 1 ? '' : 's'} to files other than pictures ${stats.files === 1 ? 'was' : 'were'} turned into plain words (the files themselves are not brought in).`)
    if (stats.pictures) report.push(`${stats.pictures} picture${stats.pictures === 1 ? ' was' : 's were'} left out (not in the export).`)
    if (stats.boxes) report.push(`${stats.boxes} callout${stats.boxes === 1 ? '' : 's'} became quotes.`)
    return { notes, report }
  },
}

// ── a Bear note (.textpack): "Export Notes ▸ TextPack" ──────────────────────────────────────────
// The note's words with its pictures; Bear's #tags are taken out of the text and put in the note's properties (tags), and its ::highlights:: lose their marks.
const bear = {
  id: 'bear', title: 'Bear note (TextPack) to a note', extensions: ['.textpack', '.textbundle'], files: 'Bear notes',
  async convert(file) {
    const zip = await unzip(file.bytes)
    const textName = zip.names.find((n) => /(^|\/)text\.(md|markdown|mdown|txt)$/i.test(n))
    if (!textName) throw new Error('This is not a TextPack (it has no text.md).')
    const base = textName.split('/').slice(0, -1).join('/')
    let text = (await zip.text(textName)).replace(/^﻿/, '').replace(/\r\n/g, '\n')
    const images = {}
    const keys = new Map()
    const skipped = { pictures: 0, highlights: 0, links: 0 }
    const parts = text.split(/(^```[\s\S]*?^```|`[^`\n]*`)/m)                           // (code is left as it is)
    const tags = []
    for (let k = 0; k < parts.length; k += 2) {
      let part = parts[k]
      const pending = []
      for (const found of part.matchAll(/!\[([^\]]*)\]\(([^)\s]+)\)/g)) pending.push(found)
      for (const found of pending) {
        const target = decodeURIComponent(found[2]).replace(/^\.\//, '')
        const path = base ? `${base}/${target}` : target
        if (/^(https?:)/i.test(found[2])) continue
        if (!keys.has(path)) { const data = await zip.read(path); if (data && /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(path)) { const key = `i${Object.keys(images).length + 1}`; images[key] = { name: path.split('/').pop(), bytes: data }; keys.set(path, key) } else keys.set(path, null) }
      }
      part = part.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (whole, alt, href) => {
        if (/^(https?:)/i.test(href)) return whole
        const path = (base ? `${base}/` : '') + decodeURIComponent(href).replace(/^\.\//, '')
        const key = keys.get(path)
        if (key) return `![${alt}](image:${key})`
        skipped.pictures += 1
        return ''
      })
      part = part.replace(/::([^:\n][^\n]*?)::/g, (_m, inner) => { skipped.highlights += 1; return inner })
      // tags: "#word" and "#two words#"; a line that is only tags is taken out, a tag inside a sentence stays where it is (and is a tag of the note too)
      part = part.split('\n').map((line) => {
        if (/^#{1,6} /.test(line)) return line                                          // (a heading, not a tag)
        const found = []
        const multi = /(^|[ \t])#([^\s#][^#\n]{0,40}[^\s#])#(?=[ \t]|$)/g
        let rest = line.replace(multi, (_m, lead, tag) => { found.push(tag); return lead })
        rest = rest.replace(/(^|[ \t])#([^\s#][^\s#]*)(?=[ \t]|$)/g, (whole, lead, tag) => { if (/^[0-9a-fA-F]{3,8}$/.test(tag)) return whole; found.push(tag.replace(/[.,;:!?)]+$/, '')); return lead })
        tags.push(...found)
        return found.length && !rest.trim() ? null : line
      }).filter((line) => line !== null).join('\n')
      skipped.links += (part.match(/\[\[[^\]]+\]\]/g) || []).length
      parts[k] = part
    }
    text = parts.join('').replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim()
    const heading = /^#{1,6} (.+)$/m.exec(text)
    const name = heading ? heading[1].replace(/[*_`]/g, '').trim() : file.name.replace(/\.[^.]*$/, '')
    const unique = [...new Set(tags)]
    const markdown = propertiesBlock({ tags: unique }) + text
    const report = []
    if (unique.length) report.push(`${unique.length} tag${unique.length === 1 ? '' : 's'} (${unique.slice(0, 6).map((t) => '#' + t).join(', ')}${unique.length > 6 ? ', …' : ''}) moved into the note's tags.`)
    if (skipped.highlights) report.push(`${skipped.highlights} highlight${skipped.highlights === 1 ? '' : 's'} (::like this::) lost ${skipped.highlights === 1 ? 'its' : 'their'} marks: Spry's notes have no highlight in plain text.`)
    if (skipped.links) report.push(`${skipped.links} link${skipped.links === 1 ? '' : 's'} to other Bear notes ([[like this]]) stay as written: the other notes are separate files.`)
    if (skipped.pictures) report.push(`${skipped.pictures} picture${skipped.pictures === 1 ? ' was' : 's were'} left out (not in the file).`)
    return { notes: [{ name, markdown, images }], report }
  },
}

// ── the plugin ──────────────────────────────────────────────────────────────────────────────────
export default function start(api) {
  const library = { unzip, decodeText, decodeEntities, attribute, escapeText, parseXml, htmlToMarkdown, csvRows, markdownTable, propertiesBlock, pathParts }
  const offs = [
    api.points.importers.add({ ...epub, group: 'documents', makes: 'note', library }),
    api.points.importers.add({ ...odt, group: 'documents', makes: 'note', library }),
    api.points.importers.add({ ...rtf, group: 'documents', makes: 'note', library }),
    api.points.importers.add({ ...html, group: 'text', makes: 'note', library }),
    api.points.importers.add({ ...notion, group: 'documents', makes: 'note', library }),
    api.points.importers.add({ ...bear, group: 'documents', makes: 'note', library }),
  ]
  return () => offs.forEach((off) => off())
}
