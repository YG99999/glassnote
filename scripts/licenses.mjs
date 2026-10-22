// Preserve upstream notices alongside the distributed executable.
import { execFileSync } from 'node:child_process';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
const metadata = JSON.parse(execFileSync('cargo', ['metadata', '--locked', '--format-version', '1', '--manifest-path', 'src-tauri/Cargo.toml'], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }));
const notices = new Map();
async function collect(folder, label, depth = 0) {
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name);
    if (entry.isFile() && /^(licen[cs]e|copying|notice)([._-]|$)/i.test(entry.name)) {
      const body = await readFile(path, 'utf8');
      if (body.includes('\0') || body.length > 512_000) continue;
      const labels = notices.get(body) || new Set();
      labels.add(label + ' / ' + entry.name);
      notices.set(body, labels);
    } else if (entry.isDirectory() && depth < 2 && /^(licenses?|whisper\.cpp|ggml|vendor)$/i.test(entry.name)) {
      await collect(path, label + ' / ' + entry.name, depth + 1);
    }
  }
}
for (const pkg of metadata.packages) {
  if (pkg.name !== 'glassnote') await collect(dirname(pkg.manifest_path), `${pkg.name} ${pkg.version}`);
}
await collect('node_modules/@tauri-apps/api', '@tauri-apps/api');
const whisperLicense = await fetch('https://raw.githubusercontent.com/openai/whisper/main/LICENSE');
if (!whisperLicense.ok) throw Error('Could not read the Whisper model license');
notices.set(await whisperLicense.text(), new Set(['OpenAI Whisper model weights']));
notices.set(await readFile('public/EGUI_GLASS_LICENSE.txt', 'utf8'), new Set(['heonny/egui-glass shader adaptation · 63b467e68327c54ad17dbc9550d306d2ea1d17cd']));
const text = ['Glassnote third-party license notices', 'These notices cover application dependencies and their build tools. Components retain their original licenses.', ...[...notices].map(([body, labels]) => '\n' + '='.repeat(72) + '\n' + [...labels].sort().join('\n') + '\n\n' + body)].join('\n\n');
await writeFile('THIRD_PARTY_LICENSES.txt', text);
console.log(`Collected ${notices.size} upstream notice texts.`);
