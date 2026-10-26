// Вложения заказа kwork — общее для radar.js и draft.js. docx/xlsx/txt читаем сами в текст (xlsx — все листы),
// pdf и картинки кладем в папку att/ — их читает Claude инструментом Read. Что прочитать не удалось — в skipped с причиной.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const PER_FILE = 40000; // знаков текста с одного файла: больше модели в один заход не нужно
const TOTAL = 120000;   // знаков на все вложения заказа

// Все записи zip (docx/xlsx — это zip) по центральному каталогу: { имя: Buffer }.
function unzip(buf) {
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) return null;
  const out = {};
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = buf.readUInt16LE(eocd + 10); n > 0; n--) {
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42), name = buf.toString('utf8', p + 46, p + 46 + nlen);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + csize);
    out[name] = method === 8 ? zlib.inflateRawSync(data) : data;
    p += 46 + nlen + xlen + clen;
  }
  return out;
}
const unzipEntry = (buf, name) => { const e = unzip(buf)?.[name]; return e ? e.toString('utf8') : null; };

const ent = s => String(s || '').replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([\da-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16))).replace(/&amp;/g, '&');

function docxText(z) {
  const x = z['word/document.xml']?.toString('utf8');
  if (x == null) throw new Error('нет word/document.xml');
  return ent(x.replace(/<w:tab\/>/g, '\t').replace(/<\/w:tc>/g, '\t').replace(/<\/w:p>|<\/w:tr>/g, '\n')).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

// xlsx: строки из sharedStrings, значения из каждого листа; ячейки строки — через «|».
function xlsxText(z) {
  const shared = [...(z['xl/sharedStrings.xml']?.toString('utf8') || '').matchAll(/<si>([\s\S]*?)<\/si>/g)].map(m => ent(m[1]));
  const wb = z['xl/workbook.xml']?.toString('utf8') || '';
  const names = [...wb.matchAll(/<sheet [^>]*name="([^"]*)"/g)].map(m => ent(m[1]));
  const sheets = Object.keys(z).filter(n => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort((a, b) => parseInt(a.match(/\d+/)) - parseInt(b.match(/\d+/)));
  if (!sheets.length) throw new Error('нет листов');
  return sheets.map((n, i) => {
    const rows = [...z[n].toString('utf8').matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)].map(r =>
      [...r[1].matchAll(/<c ([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)].map(c => {
        const t = (c[1].match(/t="(\w+)"/) || [])[1], body = c[2] || '';
        if (t === 'inlineStr') return ent((body.match(/<is>([\s\S]*?)<\/is>/) || [])[1]);
        const v = (body.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
        return v == null ? '' : t === 's' ? shared[+v] ?? '' : ent(v);
      }).join(' | ').replace(/( \| )+$/, '')).filter(r => r.replace(/[ |]/g, ''));
    return `Лист «${names[i] || i + 1}» (строк ${rows.length}):\n${rows.join('\n')}`;
  }).join('\n\n');
}

// files: [{ name, url, size }]; download(url) → Buffer (бросает ошибку, если вместо файла страница входа).
// dir — папка для pdf/картинок, rel(file) — путь, который увидит модель. Возвращает { text, paths, skipped: ['имя: причина'] }.
async function readFiles(id, files, { download, dir, rel, log = () => {}, pause = 500 }) {
  const out = { text: '', paths: [], skipped: [] };
  fs.mkdirSync(dir, { recursive: true });
  for (const [i, f] of files.entries()) {
    const ext = path.extname(f.name).toLowerCase();
    // docx/xlsx бывают тяжелыми из-за картинок внутри, а нужен только текст — им предел выше.
    if (!f.url) { out.skipped.push(`${f.name}: нет ссылки`); continue; }
    if (f.size > (['.docx', '.xlsx'].includes(ext) ? 60e6 : 20e6)) { out.skipped.push(`${f.name}: слишком большой`); continue; }
    try {
      if (['.pdf', '.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(ext)) {
        const file = path.join(dir, `${id}_${i}${ext}`);
        fs.writeFileSync(file, await download(f.url));
        out.paths.push(rel(file));
      } else if (['.docx', '.xlsx', '.txt', '.csv', '.md', '.json', '.html', '.htm'].includes(ext)) {
        const buf = await download(f.url);
        let t = ext === '.docx' ? docxText(unzip(buf) || {}) : ext === '.xlsx' ? xlsxText(unzip(buf) || {}) : buf.toString('utf8');
        if (['.html', '.htm'].includes(ext)) t = ent(t.replace(/<(script|style)[\s\S]*?<\/\1>/gi, '').replace(/<\/(p|div|tr|li|h\d)>|<br\s*\/?>/gi, '\n'));
        const room = TOTAL - out.text.length;
        if (room < 500) { out.skipped.push(`${f.name}: не вошел в предел текста`); continue; }
        const cut = Math.min(PER_FILE, room);
        out.text += `\n[${f.name}]\n${t.slice(0, cut)}${t.length > cut ? `\n[...обрезано: прочитано ${cut} из ${t.length} знаков]` : ''}\n`;
      } else out.skipped.push(`${f.name}: формат ${ext || 'без расширения'} не читается`);
    } catch (e) { out.skipped.push(`${f.name}: ${e.message}`); log(`вложение ${id} ${f.name}: ${e.message}`); }
    if (pause) await new Promise(r => setTimeout(r, pause));
  }
  return out;
}

module.exports = { readFiles, unzip, unzipEntry, docxText, xlsxText };
