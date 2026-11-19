// EPUB books as notes: an importer plugin (docs/import-spec.md, "Importers"). Copy this folder into your Plugins folder.
//
// An importer is a function that is handed a file and answers with notes: { notes: [{ name, markdown, images?: { KEY: { name, bytes } } }], report?: [words] }.
// It runs in a sealed background worker, so it is COPIED there as text: it can use nothing outside itself (no imports, no variables of this file). That is why
// everything it needs -- a reader for zip files, a reader for the book's packaging, a converter from the book's pages to markdown -- is written inside it.
// A picture is written in the markdown as ![alt](image:KEY) and its bytes are given under KEY; Spry puts it in the note's own image store.
export default function start(api) {
  return api.points.importers.add({
    id: 'epub',
    title: 'EPUB book to a note',
    extensions: ['.epub'],
    group: 'documents',
    makes: 'note',
    files: 'EPUB books',
    async convert(file) {
      const bytes = file.bytes
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      const utf8 = new TextDecoder('utf-8')
      const PICTURES = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg']

      // ── a zip file: the list of its parts, and each part read (stored, or deflated) ──
      const parts = new Map()
      let end = -1
      for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i -= 1) if (view.getUint32(i, true) === 0x06054b50) { end = i; break }
      if (end < 0) throw new Error('This is not an EPUB book (it is not a zip file).')
      let at = view.getUint32(end + 16, true)
      for (let n = view.getUint16(end + 10, true); n > 0 && view.getUint32(at, true) === 0x02014b50; n -= 1) {
        const nameLength = view.getUint16(at + 28, true)
        const name = utf8.decode(bytes.subarray(at + 46, at + 46 + nameLength))
        parts.set(name, { method: view.getUint16(at + 10, true), size: view.getUint32(at + 20, true), offset: view.getUint32(at + 42, true) })
        at += 46 + nameLength + view.getUint16(at + 30, true) + view.getUint16(at + 32, true)
      }
      const read = async (name) => {
        const part = parts.get(name)
        if (!part) return null
        if (part.size === 0xFFFFFFFF) throw new Error('This book is too big for this importer (a zip64 file).')
        const start = part.offset + 30 + view.getUint16(part.offset + 26, true) + view.getUint16(part.offset + 28, true)
        const raw = bytes.subarray(start, start + part.size)
        if (part.method === 0) return raw
        if (part.method !== 8) throw new Error('A part of this book is packed in a way this importer cannot read.')
        return new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer())
      }
      const text = async (name) => { const data = await read(name); return data ? utf8.decode(data) : null }

      // ── the book's packaging: which file holds the list of chapters, and in what order they come ──
      const encryption = await text('META-INF/encryption.xml')
      if (encryption && /Algorithm="(?!http:\/\/www\.idpf\.org\/2008\/embedding|http:\/\/ns\.adobe\.com\/pdf\/enc#RC)/.test(encryption)) {
        throw new Error('This book is protected (DRM) and cannot be read.')
      }
      const container = await text('META-INF/container.xml')
      const rootfile = container && /full-path\s*=\s*["']([^"']+)["']/.exec(container)
      if (!rootfile) throw new Error('This is not an EPUB book (it has no package file).')
      const opfPath = rootfile[1]
      const opf = await text(opfPath)
      if (!opf) throw new Error('This book has no package file.')
      const folderOf = (path) => path.slice(0, path.lastIndexOf('/') + 1)
      const resolve = (base, href) => {
        const out = folderOf(base).split('/').filter(Boolean)
        for (const piece of decodeURIComponent(href.split('#')[0]).split('/')) {
          if (piece === '..') out.pop()
          else if (piece && piece !== '.') out.push(piece)
        }
        return out.join('/')
      }
      const attribute = (tag, name) => { const found = new RegExp(`(?:^|[\\s<])${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(tag); return found ? (found[1] ?? found[2]) : null }
      const decodeEntities = (value) => value
        .replace(/&#x([0-9a-f]+);/gi, (_m, hex) => String.fromCodePoint(parseInt(hex, 16)))
        .replace(/&#(\d+);/g, (_m, number) => String.fromCodePoint(Number(number)))
        .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
      const manifest = new Map()
      for (const tag of opf.match(/<(?:\w+:)?item\b[^>]*>/g) || []) manifest.set(attribute(tag, 'id'), { href: attribute(tag, 'href'), type: attribute(tag, 'media-type') || '', properties: attribute(tag, 'properties') || '' })
      const order = []
      for (const tag of opf.match(/<(?:\w+:)?itemref\b[^>]*>/g) || []) {
        const item = manifest.get(attribute(tag, 'idref'))
        if (item && item.href && !/\bnav\b/.test(item.properties)) order.push(resolve(opfPath, item.href))        // (the book's own table of contents is left out: the headings are in the text)
      }
      const metadata = (name) => { const found = new RegExp(`<dc:${name}\\b[^>]*>([\\s\\S]*?)</dc:${name}>`).exec(opf); return found ? decodeEntities(found[1].replace(/<[^>]+>/g, '')).trim() : '' }

      // ── a chapter (XHTML) as markdown ──
      const images = {}
      const imageKeys = new Map()
      const skipped = { pictures: 0, links: 0 }
      const picture = async (chapter, source) => {
        const path = resolve(chapter, decodeEntities(source))
        if (imageKeys.has(path)) return imageKeys.get(path)
        const suffix = (path.match(/\.[^./]*$/) || [''])[0].toLowerCase()
        const data = PICTURES.includes(suffix) ? await read(path) : null
        if (!data) { skipped.pictures += 1; imageKeys.set(path, null); return null }
        const key = `i${Object.keys(images).length + 1}`
        images[key] = { name: path.split('/').pop(), bytes: data }
        imageKeys.set(path, key)
        return key
      }
      const escapeText = (value) => value.replace(/([\\`*_[\]<])/g, '\\$1')
      const chapterToMarkdown = async (path, html) => {
        html = html.replace(/<\?xml[\s\S]*?\?>|<!DOCTYPE[\s\S]*?>|<!--[\s\S]*?-->|<head\b[\s\S]*?<\/head>|<script\b[\s\S]*?<\/script>|<style\b[\s\S]*?<\/style>/gi, '')
        const body = /<body\b[^>]*>([\s\S]*)<\/body>/i.exec(html)
        html = body ? body[1] : html
        const keys = new Map()
        for (const tag of html.match(/<img\b[^>]*>/gi) || []) { const source = attribute(tag, 'src'); if (source && !keys.has(source)) keys.set(source, await picture(path, source)) }
        const out = []
        let line = ''
        let prefix = ''
        let quote = 0
        let lists = []
        let hold = null                                                             // (a cell of a table: its words wait here)
        let table = null
        let pre = null
        let kept = ''                                                               // what the last block was: list items stand close together
        const marks = []
        const flush = () => {
          const words = line.replace(/[ \t]+\n/g, '\n').trim()
          line = ''
          if (!words) { prefix = ''; return }
          const lead = '> '.repeat(quote) + prefix
          const block = words.split('\n').map((part, i) => (i === 0 ? lead : '> '.repeat(quote) + ' '.repeat(prefix.length)) + part).join('\n')
          out.push((kept === 'item' && prefix && /^(\s*)(- |\d+\. )/.test(prefix) ? '\n' : '\n\n') + block)
          kept = /^(\s*)(- |\d+\. )/.test(prefix) ? 'item' : 'block'
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
            case 'p': case 'div': case 'section': case 'article': case 'figure': case 'figcaption': case 'header': case 'footer': case 'aside': case 'dd': case 'dt': flush(); break
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
                const target = attribute(attrs, 'href')
                marks.push(target && /^(https?:|mailto:)/i.test(target) ? decodeEntities(target) : null)
                if (target && !/^(https?:|mailto:)/i.test(target)) skipped.links += 1
                add(marks[marks.length - 1] ? '[' : '')
              } else {
                const target = marks.pop()
                add(target ? `](${target.replace(/\)/g, '%29')})` : '')
              }
              break
            case 'img': {
              const key = keys.get(attribute(attrs, 'src'))
              if (key) add(`![${(decodeEntities(attribute(attrs, 'alt') || '')).replace(/[\]\n]/g, ' ')}](image:${key})`)
              break
            }
            case 'table': if (!closing) { flush(); table = [] } else if (table) { const width = Math.max(1, ...table.map((row) => row.length)); const rows = table.map((row) => row.concat(Array(width - row.length).fill(''))); out.push('\n\n| ' + rows[0].join(' | ') + ' |\n|' + ' --- |'.repeat(width) + rows.slice(1).map((row) => '\n| ' + row.join(' | ') + ' |').join('')); kept = 'block'; table = null } break
            case 'tr': if (table && !closing) table.push([]); break
            case 'td': case 'th': if (table && table.length) { if (!closing) hold = ''; else { table[table.length - 1].push(hold.trim().replace(/\|/g, '\\|')); hold = null } } break
            default: break
          }
        }
        flush()
        return out.join('')
      }

      let markdown = ''
      for (const path of order) {
        const html = await text(path)
        if (html) markdown += await chapterToMarkdown(path, html)
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
  })
}
