import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';

import puppeteerExtra from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

// ✅ Use puppeteer-core instead of puppeteer
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

// ✅ Static frontend
app.use(cors());
app.use(bodyParser.json());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ✅ Google Gemini init
const ai = new GoogleGenAI({});

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
You are summarizing part ${i + 1} of a novel chapter.
Write 5-8 bullet points capturing:

- Main plot events
- Character interactions & emotional shifts
- Clues / foreshadowing
- Important world-building
- How this connects to earlier or later events

TEXT:
---
${chunks[i]}
---`;

    const resp = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt,
    });

    chunkSummaries.push(resp.text.trim());
  }

  const finalPrompt = `
Combine the chunk summaries into a 300-400 word chapter summary.
Keep chronology, characters, major events, conflicts, world details.
No repetition. No new invented content.

Chunks:
${chunkSummaries.join('\n')}
  `;

  const finalResp = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: finalPrompt,
  });

  return finalResp.text.trim();
}

// ✅ Scraper route
app.get('/scrape', async (req, res) => {
  let browser;
  try {
    const url = req.query.url;
    if (!url) {
      return res.json({ success: false, error: "URL missing. Use /scrape?url=CHAPTER_URL" });
    }

    // ✅ Render-safe headless Puppeteer
    browser = await puppeteer.launch({
      executablePath: await chromium.executablePath,
      args: chromium.args,
      headless: chromium.headless,
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

app.listen(port, () =>
  console.log(`✅ Server running at http://localhost:${port}`)
);
