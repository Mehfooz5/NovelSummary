import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';

import puppeteerExtra from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

// ✅ Use puppeteer-core instead of full puppeteer
import puppeteer from 'puppeteer-core';
import chromium from 'chrome-aws-lambda';

import dotenv from 'dotenv';
import { GoogleGenAI } from '@google/genai';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();
puppeteerExtra.use(StealthPlugin());

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json());

// ✅ serve HTML/CSS from public folder
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ✅ Gemini init
const ai = new GoogleGenAI({});

// ✅ Chunk system
function chunkText(s, chunkSize = 6000) {
  const chunks = [];
  for (let i = 0; i < s.length; i += chunkSize) {
    chunks.push(s.slice(i, i + chunkSize));
  }
  return chunks;
}

async function summarizeLongText(fullText) {
  const chunks = chunkText(fullText);
  const chunkSummaries = [];

  for (let i = 0; i < chunks.length; i++) {
    const prompt = `
You are summarizing part ${i + 1}.
Write 5-8 bullet points covering major events, characters, emotions, clues:

${chunks[i]}
`;

    const resp = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt,
    });

    chunkSummaries.push(resp.text.trim());
  }

  const finalResp = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: `
Combine all summaries into a final chapter summary:

${chunkSummaries.join('\n')}
    `
  });

  return finalResp.text.trim();
}

app.get('/scrape', async (req, res) => {
  let browser;
  try {
    const url = req.query.url;
    if (!url) {
      return res.json({ success: false, error: "URL missing. Use /scrape?url=CHAPTER_URL" });
    }

    // ✅ FINAL puppeteer launch (works on all hosts)
    browser = await puppeteer.launch({
      executablePath: await chromium.executablePath || undefined,
      args: [
        ...chromium.args,
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-gpu",
        "--disable-dev-shm-usage",
        "--disable-web-security",
        "--disable-features=IsolateOrigins",
        "--disable-site-isolation-trials"
      ],
      headless: true,
    });

    const page = await browser.newPage();
    await page.setExtraHTTPHeaders({
      'user-agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'accept-language': 'en-US,en;q=0.9',
    });

    page.setDefaultNavigationTimeout(120000);

    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#chr-content', { timeout: 15000 });

    const paragraphs = await page.$$eval('#chr-content p', (els) =>
      els.map((e) => e.innerText.trim()).filter((t) => t.length > 0)
    );

    const chapterLinks = await page.$$eval('.btn-group a', (links) => {
      let prev = null, next = null;
      links.forEach((l) => {
        if (l.id === 'prev_chap') prev = l.href;
        if (l.id === 'next_chap') next = l.href;
      });
      return { prev, next };
    });

    await browser.close();

    const summary = await summarizeLongText(paragraphs.join('\n'));

    res.json({
      success: true,
      count: paragraphs.length,
      summary,
      prevChapter: chapterLinks.prev,
      nextChapter: chapterLinks.next,
      currentUrl: url,
    });

  } catch (error) {
    if (browser) try { await browser.close(); } catch {}
    res.json({ success: false, error: error.message });
  }
});

app.listen(port, () => console.log(`✅ Server running at http://localhost:${port}`));
