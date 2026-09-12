// Builds a distributable ZIP of the extension: manifest.json + src/ only.
//
// Writes the archive itself rather than shelling out to a zip tool or pulling in
// a dependency, so packaging works the same way the rest of this project does —
// plain Node, no build system. Run with `npm run package`.

import { deflateRawSync } from "node:zlib";
import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync } from "node:fs";
import { join, relative, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "dist");

// Everything Chrome needs at runtime, and nothing else: no tests, no demo
// harness, no docs, no node_modules, no packaging script.
const INCLUDE = ["manifest.json", "src"];

// ---------------------------------------------------------------- zip writer

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ZIP stores timestamps in the MS-DOS format: 2-second resolution, epoch 1980.
const dosTime = (d) => (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
const dosDate = (d) => ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();

function buildZip(entries, now = new Date()) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const time = dosTime(now);
  const date = dosDate(now);

  for (const { name, data } of entries) {
    const deflated = deflateRawSync(data, { level: 9 });
    // A tiny file can deflate larger than it started; store it raw if so.
    const useDeflate = deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const method = useDeflate ? 8 : 0;
    const sum = crc32(data);
    const nameBuf = Buffer.from(name, "utf8");

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);      // version needed
    local.writeUInt16LE(0, 6);       // flags
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(sum, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);      // extra field length
    chunks.push(local, nameBuf, body);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);        // version made by
    dir.writeUInt16LE(20, 6);        // version needed
    dir.writeUInt16LE(0, 8);
    dir.writeUInt16LE(method, 10);
    dir.writeUInt16LE(time, 12);
    dir.writeUInt16LE(date, 14);
    dir.writeUInt32LE(sum, 16);
    dir.writeUInt32LE(body.length, 20);
    dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(nameBuf.length, 28);
    dir.writeUInt16LE(0, 30);        // extra
    dir.writeUInt16LE(0, 32);        // comment
    dir.writeUInt16LE(0, 34);        // disk number
    dir.writeUInt16LE(0, 36);        // internal attrs
    dir.writeUInt32LE(0, 38);        // external attrs
    dir.writeUInt32LE(offset, 42);
    central.push(dir, nameBuf);

    offset += local.length + nameBuf.length + body.length;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...chunks, centralBuf, end]);
}

// ------------------------------------------------------------- file gathering

function collect(pathFromRoot, out = []) {
  const abs = join(ROOT, pathFromRoot);
  const st = statSync(abs);
  if (st.isDirectory()) {
    for (const child of readdirSync(abs).sort()) collect(join(pathFromRoot, child), out);
  } else {
    // ZIP entry names are always forward-slashed, whatever the host OS uses.
    out.push({ name: relative(ROOT, abs).split(sep).join("/"), data: readFileSync(abs) });
  }
  return out;
}

// --------------------------------------------------------------- manifest check

// Every path the manifest points at must actually be in the archive. This is the
// failure mode this project has actually hit: a module added to src/ and imported
// dynamically, but left out of web_accessible_resources, fails only at runtime
// inside the bank page.
function manifestReferences(manifest) {
  const refs = [];
  const push = (p) => { if (typeof p === "string") refs.push(p); };

  push(manifest.action?.default_popup);
  push(manifest.options_page);
  push(manifest.background?.service_worker);
  for (const cs of manifest.content_scripts ?? []) {
    (cs.js ?? []).forEach(push);
    (cs.css ?? []).forEach(push);
  }
  for (const war of manifest.web_accessible_resources ?? []) {
    (war.resources ?? []).forEach(push);
  }
  for (const icon of Object.values(manifest.icons ?? {})) push(icon);

  // Wildcards would need globbing; nothing here uses them, so flag rather than guess.
  return refs.filter((r) => !r.includes("*"));
}

// ----------------------------------------------------------------------- main

const manifest = JSON.parse(readFileSync(join(ROOT, "manifest.json"), "utf8"));
const entries = INCLUDE.flatMap((p) => collect(p));
const names = new Set(entries.map((e) => e.name));

const missing = manifestReferences(manifest).filter((r) => !names.has(r));
if (missing.length) {
  console.error("Manifest references files that are not in the package:");
  for (const m of missing) console.error(`  ${m}`);
  process.exit(1);
}

// Modules imported dynamically must be web-accessible or the import is blocked.
const war = new Set(
  (manifest.web_accessible_resources ?? []).flatMap((w) => w.resources ?? [])
);
const unreachable = [...names].filter(
  (n) => n.startsWith("src/content/") && n.endsWith(".js") &&
         n !== manifest.content_scripts?.[0]?.js?.[0] && !war.has(n)
).concat(
  [...names].filter((n) => n.startsWith("src/core/") && !war.has(n))
);
if (unreachable.length) {
  console.warn("Warning: shipped but not in web_accessible_resources —");
  for (const u of unreachable) console.warn(`  ${u}`);
  console.warn("  A dynamic import() of these will fail inside the bank page.");
}

mkdirSync(OUT_DIR, { recursive: true });
const outFile = join(OUT_DIR, `banking-assistant-esun-v${manifest.version}.zip`);
const zip = buildZip(entries);
writeFileSync(outFile, zip);

const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
console.log(`${manifest.name} ${manifest.version}`);
console.log(`  ${entries.length} files, ${kb(entries.reduce((a, e) => a + e.data.length, 0))} raw`);
console.log(`  -> ${relative(ROOT, outFile)} (${kb(zip.length)})`);
if (!manifest.icons) console.log("  note: no icons declared; Chrome will show the default puzzle piece.");
