import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import dotenv from 'dotenv';
import { GoogleGenAI } from '@google/genai';
import path from 'path';
import { fileURLToPath } from 'url';   // ✅ added

dotenv.config();
puppeteer.use(StealthPlugin());

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json());

// ✅ for serving HTML/CSS
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use(express.static(path.join(__dirname))); // serves index.html & style.css

// ✅ default route so browser loads frontend
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ✅ Initialize Google Gemini AI client (reads GEMINI_API_KEY from env)
const ai = new GoogleGenAI({});

// ---- Chunking system for long chapters ----
function chunkText(s, chunkSize = 6000) {
  const chunks = [];
  for (let i = 0; i < s.length; i += chunkSize) {
    chunks.push(s.slice(i, i + chunkSize));
  }
  return chunks;
}

// ✅ Summarize using Google Gemini
async function summarizeLongText(fullText) {
  const chunks = chunkText(fullText);

  const chunkSummaries = [];
  for (let i = 0; i < chunks.length; i++) {
    const prompt = `
You are summarizing part ${i + 1} of a novel chapter.
Write 5-8 bullet points capturing:

- Main plot events happening in this section
- Important character interactions and emotional shifts
- Any reveals, hidden clues, or foreshadowing
- World-building or lore details that matter later
- How this section connects to earlier or later events

Do NOT rewrite creatively or add your own ideas.
Only summarize information from the given text.

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
You will receive multiple chunk summaries.  
Combine them into a single coherent 300-400 word chapter summary.

Requirements:
- Maintain chronological order
- Include major plot events and consequences
- Keep key character interactions, conflicts, and emotional changes
- Include hidden clues / foreshadowing
- Include important world-building or lore
- Do not repeat, over-condense, or invent new details

Chunk Summaries:
---
${chunkSummaries.join('\n')}
---

Output ONLY the final summary.
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

    browser = await puppeteer.launch({
      headless: false,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
      defaultViewport: null,
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

    // ✅ Extract paragraphs
    const paragraphs = await page.$$eval('#chr-content p', (els) =>
      els.map((e) => e.innerText.trim()).filter((t) => t.length > 0)
    );

    // ✅ Extract Next & Previous chapter URLs
    const chapterLinks = await page.$$eval('.btn-group a', (links) => {
      let prev = null, next = null;
      links.forEach((l) => {
        if (l.id === 'prev_chap') prev = l.href;
        if (l.id === 'next_chap') next = l.href;
      });
      return { prev, next };
    });

    await browser.close();

    const fullText = paragraphs.join('\n');

    // ✅ Google Gemini summary
    const summary = await summarizeLongText(fullText);

    res.json({
      success: true,
      count: paragraphs.length,
      summary,
      prevChapter: chapterLinks.prev,
      nextChapter: chapterLinks.next,
      currentUrl: url
    });

  } catch (error) {
    if (browser) try { await browser.close(); } catch {}
    res.json({ success: false, error: error.message });
  }
});

app.listen(port, () =>
  console.log(`✅ Server running at http://localhost:${port}`)
);
