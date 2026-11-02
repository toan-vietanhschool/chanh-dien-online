// node gen.mjs <skin> <action>
// Asks Codex (image_generation) for one action strip and copies the newest
// generated image to raw/<skin>/<action>.png. Every run is logged to raw/gen-log.jsonl.
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, renameSync, appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const RAW = join(HERE, 'raw');
const IMAGES = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'generated_images');
// Model and reasoning effort for every Codex call; override with CODEX_MODEL / CODEX_EFFORT.
const CODEX_MODEL = process.env.CODEX_MODEL || 'gpt-6-sol';
const CODEX_EFFORT = process.env.CODEX_EFFORT || 'low';
const TIMEOUT_MS = 10 * 60 * 1000;
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp']);

function fail(msg, extra = '') {
  console.error(`gen: ${msg}`);
  if (extra) console.error(extra);
  process.exit(1);
}

// Prefer the npm-installed CLI (codex.js) so no shell is needed; CODEX_JS overrides.
function codexCommand() {
  if (process.env.CODEX_JS) return [process.execPath, [process.env.CODEX_JS]];
  // Global node_modules sits next to node.exe on Windows, under ../lib elsewhere.
  const nodeDir = dirname(process.execPath);
  for (const mods of [join(nodeDir, 'node_modules'), join(nodeDir, '..', 'lib', 'node_modules')]) {
    const js = join(mods, '@openai', 'codex', 'bin', 'codex.js');
    if (existsSync(js)) return [process.execPath, [js]];
  }
  return ['codex', []];
}

function buildPrompt(cfg, skin, action) {
  const a = cfg.actions[action];
  const skinKey = cfg.alias[skin] || skin;
  const who = cfg.skins[skinKey];
  if (!who) fail(`no character description for skin "${skinKey}" in prompts.json`);
  return [cfg.preamble, cfg.style, who, a.desc, cfg.suffix.replaceAll('{N}', String(a.frames))].join('\n\n');
}

function refsFor(skin, action) {
  const base = skinBase(skin);
  const refs = [`assets/c_${base}.png`];
  if (existsSync(join(ROOT, `assets/anim_${base}.png`))) refs.push(`assets/anim_${base}.png`);
  const walk = join(RAW, skin, 'walk_back.png');
  if (action !== 'walk_back' && existsSync(walk)) refs.push(relative(ROOT, walk).replaceAll('\\', '/'));
  // Seated one-shots also see the accepted idle, so cushion, palette and seated style match it.
  const idle = join(RAW, skin, 'idle.png');
  if ((action === 'bow' || action === 'thank') && existsSync(idle)) refs.push(relative(ROOT, idle).replaceAll('\\', '/'));
  for (const r of refs) if (!existsSync(join(ROOT, r))) fail(`missing reference image ${r}`);
  return refs;
}

function skinBase(skin) {
  return skin === 'master' ? 'monk' : skin;
}

function killTree(child) {
  if (process.platform === 'win32') {
    try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ }
  } else {
    child.kill('SIGKILL');
  }
}

function runCodex(args, prompt) {
  const [cmd, pre] = codexCommand();
  return new Promise((resolveRun) => {
    const child = spawn(cmd, [...pre, ...args], { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let timedOut = false;
    child.stdout.on('data', (d) => { out += d; process.stdout.write(d); });
    child.stderr.on('data', (d) => { out += d; process.stderr.write(d); });
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, TIMEOUT_MS);
    child.on('error', (e) => { clearTimeout(timer); resolveRun({ code: -1, out: `${out}\n${e.message}`, timedOut }); });
    child.on('close', (code) => { clearTimeout(timer); resolveRun({ code, out, timedOut }); });
    child.stdin.end(prompt);
  });
}

function imagesNewerThan(dir, since) {
  if (!existsSync(dir)) return [];
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...imagesNewerThan(p, since));
    else if (IMAGE_EXT.has(extname(entry.name).toLowerCase())) {
      const mtime = statSync(p).mtimeMs;
      if (mtime > since) found.push({ path: p, mtime });
    }
  }
  return found.sort((a, b) => b.mtime - a.mtime);
}

async function main() {
  const [skin, action] = process.argv.slice(2);
  const cfg = JSON.parse(readFileSync(join(HERE, 'prompts.json'), 'utf8'));
  if (!skin || !action) fail('usage: node gen.mjs <skin> <action>');
  if (!cfg.actions[action]) fail(`unknown action "${action}" (${Object.keys(cfg.actions).join(', ')})`);

  const prompt = buildPrompt(cfg, skin, action);
  const refs = refsFor(skin, action);
  // "--" ends option parsing so the multi-value -i cannot swallow the stdin marker.
  const args = ['exec', '-m', CODEX_MODEL, '-c', `model_reasoning_effort="${CODEX_EFFORT}"`,
    '--enable', 'image_generation', '-s', 'read-only', '--skip-git-repo-check',
    ...refs.flatMap((r) => ['-i', r]), '--', '-'];
  console.log(`gen: ${skin}/${action} refs=${refs.join(', ')}`);

  const start = Date.now();
  const { code, out, timedOut } = await runCodex(args, prompt);
  const session = (out.match(/session id:\s*([0-9a-f-]{36})/i) || [])[1] || null;
  // With a session id, only that session's folder counts: other Codex runs (e.g. a concurrent
  // gen.mjs) write to generated_images too. The global search is a fallback for a clean exit
  // whose session id could not be parsed.
  let searchDir = null;
  if (session) searchDir = join(IMAGES, session);
  else if (code === 0) searchDir = IMAGES;
  const fresh = searchDir ? imagesNewerThan(searchDir, start) : [];

  mkdirSync(join(RAW, skin), { recursive: true });
  appendFileSync(join(RAW, 'gen-log.jsonl'), JSON.stringify({
    at: new Date(start).toISOString(), skin, action, model: CODEX_MODEL, effort: CODEX_EFFORT, session, exit: code, timedOut,
    seconds: Math.round((Date.now() - start) / 1000), images: fresh.length, scoped: Boolean(session),
    image: fresh[0]?.path ?? null,
  }) + '\n');

  if (timedOut) fail(`codex exceeded ${TIMEOUT_MS / 60000} min and was killed`);
  if (!fresh.length) fail(`codex produced no image (exit ${code})`, out);

  const dest = join(RAW, skin, `${action}.png`);
  if (existsSync(dest)) renameSync(dest, join(RAW, skin, `${action}.${Math.floor(statSync(dest).mtimeMs)}.png`));
  await sharp(fresh[0].path).png().toFile(dest);
  console.log(`gen: ${fresh.length} new image(s); saved ${fresh[0].path} -> ${relative(ROOT, dest)}`);
}

main().catch((e) => fail(e.message));
