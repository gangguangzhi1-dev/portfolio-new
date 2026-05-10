#!/usr/bin/env node
import https from 'https';
import { createWriteStream, readFileSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import readline from 'readline';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TAGS = [
  { label: 'AI',    cls: 't2' },
  { label: '制作',  cls: 't1' },
  { label: 'AI活用', cls: 't3' },
  { label: '副業',  cls: 't4' },
];

function fetchPage(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        resolve(fetchPage(res.headers.location));
        return;
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
  });
}

function extractMeta(html, property) {
  const m = html.match(new RegExp(`<meta[^>]+property="${property}"[^>]+content="([^"]*)"`, 'i'))
    || html.match(new RegExp(`<meta[^>]+content="([^"]*)"[^>]+property="${property}"`, 'i'));
  return m ? m[1] : null;
}

function downloadImage(imgUrl, dest) {
  return new Promise((resolve, reject) => {
    const file = createWriteStream(dest);
    https.get(imgUrl, res => {
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    }).on('error', reject);
  });
}

function loadNotes() {
  const content = readFileSync(path.join(__dirname, 'notes.js'), 'utf-8');
  const m = content.match(/const NOTES = (\[[\s\S]*?\]);/);
  if (!m) throw new Error('notes.js のパースに失敗しました');
  return JSON.parse(m[1]);
}

function saveNotes(notes) {
  const content = `const NOTES = ${JSON.stringify(notes, null, 2)};\n`;
  writeFileSync(path.join(__dirname, 'notes.js'), content, 'utf-8');
}

function nextCoverNumber(notes) {
  const nums = notes.map(n => {
    const m = n.cover && n.cover.match(/note_cover_(\d+)/);
    return m ? parseInt(m[1]) : 0;
  });
  return Math.max(0, ...nums) + 1;
}

function formatDate(d = new Date()) {
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
}

function ask(rl, question) {
  return new Promise(resolve => rl.question(question, resolve));
}

async function suggestWithAI(title) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  try {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey });
    const res = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      messages: [{
        role: 'user',
        content: `note記事のタイトルからタグと紹介文（2行）を提案してください。

タイトル: ${title}

タグ候補: AI / 制作 / AI活用 / 副業

JSONのみ返してください:
{"tag": "タグ名", "excerpt": "1行目\\n2行目"}`
      }]
    });
    return JSON.parse(res.content[0].text.trim());
  } catch {
    return null;
  }
}

async function main() {
  const url = process.argv[2];
  if (!url || !url.includes('note.com')) {
    console.error('使い方: node add-note.js <note記事のURL>');
    process.exit(1);
  }

  console.log('\n記事情報を取得中...');
  const html = await fetchPage(url);
  const title = extractMeta(html, 'og:title') || 'タイトル不明';
  const imageUrl = extractMeta(html, 'og:image');

  if (!imageUrl) {
    console.error('カバー画像が取得できませんでした');
    process.exit(1);
  }

  console.log(`タイトル: ${title}`);

  const notes = loadNotes();
  const coverNum = nextCoverNumber(notes);
  const coverFile = `note_cover_${coverNum}.png`;
  const coverDest = path.join(__dirname, 'assets', coverFile);

  console.log('カバー画像をダウンロード中...');
  await downloadImage(imageUrl, coverDest);
  console.log(`assets/${coverFile} 保存完了`);

  console.log('タグと紹介文を生成中...');
  const ai = await suggestWithAI(title);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  let tag, tagClass, excerpt;

  if (ai) {
    const found = TAGS.find(t => t.label === ai.tag) || TAGS[0];
    tag = found.label;
    tagClass = found.cls;
    excerpt = ai.excerpt;
    console.log(`\n提案:\n  タグ: ${tag}\n  紹介文: ${excerpt.replace(/\n/g, ' / ')}`);
    const ans = await ask(rl, 'このまま追加しますか？ [Enter=yes / n=変更] ');
    if (ans.toLowerCase() === 'n') tag = null;
  }

  if (!tag) {
    console.log('\nタグを選んでください:');
    TAGS.forEach((t, i) => console.log(`  ${i + 1}. ${t.label}`));
    const idx = parseInt(await ask(rl, '番号: '), 10) - 1;
    const chosen = TAGS[Math.min(Math.max(idx, 0), TAGS.length - 1)];
    tag = chosen.label;
    tagClass = chosen.cls;
    const raw = await ask(rl, '紹介文（改行は\\nで。例: 1行目\\n2行目）: ');
    excerpt = raw.replace(/\\n/g, '\n');
  }

  rl.close();

  const newEntry = { url, title, excerpt, tag, tagClass, date: formatDate(), cover: `assets/${coverFile}` };
  notes.unshift(newEntry);
  saveNotes(notes);
  console.log('\nnotes.js を更新しました');

  console.log('git push → Vercel デプロイ中...');
  execSync(`git add notes.js "assets/${coverFile}"`, { cwd: __dirname, stdio: 'inherit' });
  execSync(`git commit -m "note: ${title.slice(0, 50)}"`, { cwd: __dirname, stdio: 'inherit' });
  execSync('git push', { cwd: __dirname, stdio: 'inherit' });
  console.log('\nデプロイ完了！');
}

main().catch(err => {
  console.error('エラー:', err.message);
  process.exit(1);
});
