"use strict";

require("dotenv").config({ override: true });

const express = require("express");
const axios = require("axios");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const sharp = require("sharp");
const FormData = require("form-data");

const app = express();
app.use(express.json());

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection:", reason);
});

process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err);
});

// ─── 1. CONFIGURATION & CONSTANTS ───────────────────────────────────────────

const TOKEN = process.env.TELEGRAM_TOKEN;
if (!TOKEN) {
  console.error("FATAL: Set TELEGRAM_TOKEN (Telegram bot token).");
  process.exit(1);
}

const OPENCLAW_BIN = (() => {
  if (process.env.OPENCLAW_BIN) return process.env.OPENCLAW_BIN;
  if (process.platform === "win32") {
    const candidates = [
      "C:\\Users\\BIT\\AppData\\Roaming\\npm\\openclaw.cmd",
      "C:\\Users\\BIT\\AppData\\Roaming\\npm\\openclaw.ps1",
    ];
    for (const c of candidates) if (fs.existsSync(c)) return c;
    return "openclaw.cmd";
  }
  return "openclaw";
})();

const TELEGRAM_MAX_TEXT = 3900;
const TELEGRAM_MAX_CAPTION = 900;
const OPENCLAW_MAX_RETRIES = 3;
const RECENT_TOPICS_FILE = "recent_topics.json";
const RECENT_TOPICS_LIMIT = 10;
const OR_MODEL = process.env.OR_MODEL || "google/gemini-2.0-flash-lite-001";
const OR_API_KEY = process.env.OPENROUTER_API_KEY || "";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_IMAGE_MODEL = process.env.OPENAI_IMAGE_MODEL || "dall-e-3";
const OPENAI_IMAGE_SIZE = process.env.OPENAI_IMAGE_SIZE || "1024x1024";
const OPENCLAW_MAIN = (() => {
  if (process.env.OPENCLAW_MAIN) return process.env.OPENCLAW_MAIN;
  const candidates = [
    path.join(process.env.APPDATA || "", "npm", "node_modules", "openclaw", "openclaw.mjs"),
    path.join(process.env.APPDATA || "", "npm", "node_modules", "openclaw", "dist", "openclaw.mjs"),
    path.join(__dirname, "node_modules", "openclaw", "openclaw.mjs"),
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  return null;
})();

// ─── 2. CATEGORIES & SUBREDDITS ─────────────────────────────────────────────

const CATEGORY_SUBREDDITS = {
  startup: ["startups", "entrepreneur", "SaaS", "business", "productivity"],
  edtech: ["edtech", "highereducation", "Teachers", "education"],
  ai: ["artificial", "MachineLearning", "singularity", "LocalLLaMA"],
  healthcare: ["healthtech", "medicine", "nursing", "healthcare"],
  fintech: ["fintech", "personalfinance", "crypto", "investing"]
};

const DEFAULT_CATEGORY = "startup";

function getSubredditsForCategory(category) {
  const normCat = (category || "").toLowerCase().trim();
  return CATEGORY_SUBREDDITS[normCat] || CATEGORY_SUBREDDITS[DEFAULT_CATEGORY];
}

// ─── 3. UTILITIES & STATE ───────────────────────────────────────────────────

function loadRecentTopics() {
  try {
    if (fs.existsSync(RECENT_TOPICS_FILE)) {
      const data = JSON.parse(fs.readFileSync(RECENT_TOPICS_FILE, "utf8"));
      return Array.isArray(data) ? data.slice(0, RECENT_TOPICS_LIMIT) : [];
    }
  } catch (_) { }
  return [];
}

function saveRecentTopics(topics) {
  try {
    fs.writeFileSync(RECENT_TOPICS_FILE, JSON.stringify(topics), "utf8");
  } catch (err) {
    console.warn("⚠️ Could not save recent topics:", err.message);
  }
}

const recentTopics = loadRecentTopics();

function rememberTopic(topic) {
  const key = normalizeTopic(topic);
  if (!key) return;
  const idx = recentTopics.indexOf(key);
  if (idx !== -1) recentTopics.splice(idx, 1);
  recentTopics.unshift(key);
  if (recentTopics.length > RECENT_TOPICS_LIMIT) recentTopics.length = RECENT_TOPICS_LIMIT;
  saveRecentTopics(recentTopics);
}

let isProcessing = false;

function normalizeTopic(t) {
  return String(t || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
  "Mozilla/5.0 (X11; Linux x86_64; rv:125.0) Gecko/20100101 Firefox/125.0",
];

function randomAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function logStage(stage, value) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  const clipped = text.length > 3500 ? `${text.slice(0, 3500)}\n...[truncated in logs]` : text;
  console.log(`\n===== ${stage} =====\n${clipped}\n`);
}

// ─── 4. PROMPTS BY AGENT TASK ────────────────────────────────────────────────

// AGENT 1: STORY PICKER (Analyzes signals and selects the best topic)
function buildStoryPickerPrompt(signals, source, recentTopics, category) {
  const recentBlock = recentTopics.length
    ? `\nAvoid repeating these recently posted topics:\n${recentTopics.join("\n")}`
    : "";

  const audienceMap = {
    startup: "founder and startup",
    edtech: "edtech and education",
    ai: "AI and tech",
    healthcare: "healthcare and healthtech",
    fintech: "fintech and finance"
  };

  const audience = audienceMap[(category || "").toLowerCase()] || "founder and startup";

  return [
    `You are a signal analyst looking for ${audience} stories worth a LinkedIn post.`,
    "",
    `From the community signals below, pick the ONE story most worth a LinkedIn post for a ${audience} audience.`,
    "",
    "PICK criteria — it must be ONE of:",
    "  → A major business milestone, revenue breakthrough, or pivot with a lesson",
    "  → A significant AI shift or tech advancement that concretely affects how businesses operate",
    "  → A controversial or highly debated topic in the ecosystem",
    "  → A specific, raw story about failure, success, or a hard-learned realization",
    "  → A shift in market dynamics or consumer behavior worth noting",
    "",
    "REJECT anything that is:",
    "  ❌ A minor patch, config tweak, or irrelevant story",
    "  ❌ A meta-post, hiring thread, weekly recap, or off-topic HN story",
    "  ❌ Vague or unverifiable without a primary source",
    recentBlock,
    "",
    `Sources: ${source}`,
    "Community signals:",
    signals,
    "",
    "Output EXACTLY one line: the story topic you chose. No explanation, no preamble.",
    "If nothing qualifies, output exactly: SKIP",
  ].join("\n");
}

// ─── AGENT STYLES ──────────────────────────────────────────────────────────

const POST_STYLES = [
  "Story → realization → punchline",
  "Sharp one-liner → breakdown → twist",
  "Contrarian take → example → insight",
  "Personal failure → lesson (implicit, not preachy)",
  "Observation → uncomfortable truth → mic drop",
  "Mini case study (with numbers) → unexpected insight",
  "Short chaotic thoughts → converge into one idea",
  "Dialogue format (very minimal, realistic)",
  "The 'Reverse Hook' (start with the final result, then explain the hidden cost)",
  "The 'Industry Myth-Buster' (call out a common belief and replace it with reality)",
  "Scene-setting (describe a specific moment in a room/meeting) → the takeaway",
  "The 'Why this matters' (starts with a boring fact, ends with a terrifying/exciting implication)"
];

function getRandomStyle() {
  return POST_STYLES[Math.floor(Math.random() * POST_STYLES.length)];
}

// AGENT 2: POST WRITER (Writes a viral founder-style post from a chosen story)
function buildPostWriterPrompt(chosenStory) {
  const style = getRandomStyle();
  return [
    `Write a high-impact LinkedIn post about this topic: ${chosenStory}`,
    "",
    `STYLE CONSTRAINT: You MUST write in this specific style: ${style}`,
    "",
    "Rules:",
    "Topic ≠ Post",
    "Turn the topic into a specific moment, NOT a general idea.",
    "",
    "TRUTH CONSTRAINT:",
    "- Do NOT fabricate personal experiences (e.g., do NOT say 'I had a call' or 'I raised money' if it didn't happen).",
    "- Use an OBSERVATIONAL founder voice (e.g., 'Watching this happen...', 'I'm looking at these numbers...').",
    "- Keep it grounded in the provided research data.",
    "",
    "SINGLE NARRATIVE THREAD:",
    "- Stick to ONE company, ONE event, or ONE situation.",
    "- Do NOT merge multiple unrelated stories into one post.",
    "",
    "Anchor with ONE concrete detail",
    "(number, timeframe, metric, or specific action)",
    "",
    "Write like a founder thinking out loud",
    "NOT teaching, NOT advising",
    "",
    "Avoid predictable structure",
    "Some posts can be:",
    "- very short (3–5 lines)",
    "- medium (8–15 lines)",
    "- slightly longer if needed",
    "",
    "Vary rhythm:",
    "Do NOT use multiple empty lines between paragraphs.",
    "Keep spacing tight and professional. One empty line between sections is the maximum.",
    "",
    "Formatting:",
    "Do NOT use 'broetry' style (one sentence per line with double spacing).",
    "",
    "Ban generic writing:",
    "No “Here are 5 tips”",
    "No “In today’s world”",
    "No “Businesses should”",
    "",
    "KILL GENERIC ENDINGS:",
    "- Avoid philosophical closing lines about 'the world' or 'innovation'.",
    "- End with a sharp realization, an unresolved tension, or a specific thought.",
    "",
    "",
    "Make it feel real:",
    "Include slightly uncomfortable or honest lines when relevant",
    "",
    "Hook:",
    "First line must create curiosity, tension, or contrast",
    "But vary the style of hook (question, statement, contradiction, etc.)",
    "",
    "Output:",
    "Plain text only",
    "No emojis",
    "No hashtags",
    "No explanations",
    "Only the post"
  ].join("\n");
}

// AGENT 3: TOPIC POST WRITER (Writes a post from a user-provided topic without signals)
function buildTopicPostPrompt(topic) {
  const style = getRandomStyle();
  return [
    `Write a high-impact LinkedIn post about this topic: ${topic}`,
    "",
    `STYLE CONSTRAINT: You MUST write in this specific style: ${style}`,
    "",
    "Rules:",
    "Topic ≠ Post",
    "Turn the topic into a specific moment, NOT a general idea.",
    "",
    "TRUTH CONSTRAINT:",
    "- Do NOT fabricate personal experiences.",
    "- Use an OBSERVATIONAL founder voice.",
    "",
    "Anchor with ONE concrete detail",
    "(number, timeframe, metric, or specific action)",
    "",
    "Write like a founder thinking out loud",
    "NOT teaching, NOT advising",
    "",
    "Avoid predictable structure",
    "",
    "Vary rhythm:",
    "Mix short punchy lines with occasional longer ones",
    "",
    "Formatting:",
    "Do NOT follow a fixed pattern. Vary line breaks and density.",
    "",
    "KILL GENERIC ENDINGS:",
    "- End with a sharp realization, an unresolved tension, or a specific thought.",
    "",
    "Output:",
    "Plain text only",
    "No emojis",
    "No hashtags",
    "No explanations",
    "Only the post"
  ].join("\n");
}

// AGENT 4: SIGNAL CLEANER (Removes noise and meta-posts from raw signals)
function buildSignalCleanerPrompt(signals) {
  return [
    "You are a noise-reduction specialist for a social media pipeline.",
    "",
    "Raw signals from Reddit and Hacker News follow. CLEAN them by:",
    "1. Removing all meta-posts (e.g., 'Welcome to r/fintech', 'Rules of the sub', 'AMA reminder').",
    "2. Removing generic threads (e.g., 'Weekly Hiring Thread', 'Self-promotion megathread').",
    "3. Removing obvious ads or spam.",
    "4. Grouping identical stories into one entry.",
    "",
    "Raw signals:",
    signals,
    "",
    "Output only the cleaned list of headlines, one per line. No introduction."
  ].join("\n");
}

// AGENT 5: PAIN POINT EXTRACTOR (Extracts the 'uncomfortable truth' from a story)
function buildPainPointExtractorPrompt(chosenStory) {
  return [
    "You are a deep-dive analyst. You see the human pain point behind every news headline.",
    "",
    `Topic: ${chosenStory}`,
    "",
    "Task: Extract ONE specific, raw, or uncomfortable truth/pain point that a founder would care about in this story.",
    "Why does this matter to a human? What was the mistake? What is the hidden friction?",
    "",
    "Example:",
    "Story: 'Stripe acquires Bridge'",
    "Pain Point: 'Building your own stablecoin infrastructure from scratch is officially a waste of time for 99% of startups.'",
    "",
    "Output exactly one sentence. No intro."
  ].join("\n");
}

// AGENT 6: POST POLISHER (Final pass for rhythm and flow)
function buildPostPolisherPrompt(post) {
  return [
    "You are a world-class editor. You polish LinkedIn posts to perfection.",
    "",
    "Draft:",
    post,
    "",
    "Rules for Polishing:",
    "- TIGHTEN the spacing. Ensure there are no double-empty lines.",
    "- Ensure the hook is absolutely arresting.",
    "- REMOVE any remaining AI-isms (e.g., 'In the fast-paced world', 'It's more than just').",
    "- KILL GENERIC ENDINGS: If it ends with a broad statement about the future or industry, rewrite it to be sharp and unresolved.",
    "- STICK to the 'Founder Voice' (raw, honest, observational).",
    "- Output ONLY the raw post text. No intro, no explanation."
  ].join("\n");
}

// AGENT 7: IMAGE CONCEPT STRATEGIST (Designs viral visuals for posts)
function buildImageConceptPrompt(topic, post) {
  return [
    "You are a viral image strategist. Design a high-impact visual concept for this LinkedIn post.",
    "",
    `TOPIC: ${topic}`,
    `POST CONTENT: ${post}`,
    "",
    "IMPORTANT:",
    "The visual description must NOT include any text, words, typography, letters, logos, captions, labels, or signs.",
    "Only describe background, scene, lighting, mood, composition, and texture.",
    "",
    "Return ONLY valid JSON in exactly this shape:",
    '{"headline":"...","visual":"...","highlight":"...","subtext":"..."}',
    "",
    "Field requirements:",
    "headline: 4-10 words, punchy, no hashtags",
    "visual: detailed cinematic background prompt with no text elements",
    "highlight: 1-4 words to emphasize from headline",
    "subtext: short supporting line under headline (optional but preferred)",
    "",
    "No markdown. No code fences. JSON only."
  ].join("\n");
}

async function callImageAPI(prompt) {
  if (OPENAI_API_KEY) {
    try {
      console.log(`🎨 Calling OpenAI image model (${OPENAI_IMAGE_MODEL})...`);
      const response = await axios.post(
        "https://api.openai.com/v1/images/generations",
        {
          model: OPENAI_IMAGE_MODEL,
          prompt: `${prompt}, no text, no letters, no typography, no logo, no watermark`,
          size: OPENAI_IMAGE_SIZE,
          quality: "standard",
          n: 1
        },
        {
          headers: {
            Authorization: `Bearer ${OPENAI_API_KEY}`,
            "Content-Type": "application/json"
          },
          timeout: 120000
        }
      );

      const imageData = response.data?.data?.[0] || {};
      if (imageData.url) return imageData.url;

      if (imageData.b64_json) {
        const outputPath = path.join(os.tmpdir(), `openai-image-${Date.now()}.png`);
        fs.writeFileSync(outputPath, Buffer.from(imageData.b64_json, "base64"));
        return outputPath;
      }

      throw new Error("OpenAI image response did not include a usable image");
    } catch (err) {
      console.warn(`⚠️ OpenAI image generation failed, falling back to Pollinations: ${err.message}`);
    }
  }

  console.log("🎨 Calling Pollinations.ai for image...");
  const safePrompt = `${prompt}, no text, no letters, no typography, no logo, no watermark`;
  const cleanedPrompt = encodeURIComponent(safePrompt.replace(/[\n\r]/g, " ").trim());
  const seed = Math.floor(Math.random() * 1000000);
  return `https://image.pollinations.ai/prompt/${cleanedPrompt}?width=1024&height=1024&nologo=true&seed=${seed}`;
}

function extractFirstJsonObject(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;

  try {
    return JSON.parse(raw);
  } catch (_) {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) return null;
    try {
      return JSON.parse(raw.slice(start, end + 1));
    } catch (_) {
      return null;
    }
  }
}

function normalizeImageConcept(rawConcept, topic) {
  const parsed = extractFirstJsonObject(rawConcept) || {};
  const fallbackHeadline = String(topic || "Founder reality check").slice(0, 90).trim() || "Founder reality check";

  const headline = String(parsed.headline || fallbackHeadline).replace(/\s+/g, " ").trim().slice(0, 100);
  const visual = String(parsed.visual || `cinematic editorial portrait background, moody lighting, shallow depth of field, startup office atmosphere, no text elements`).replace(/\s+/g, " ").trim();
  const highlight = String(parsed.highlight || headline.split(" ").slice(0, 2).join(" ")).replace(/\s+/g, " ").trim().slice(0, 40);
  const subtext = String(parsed.subtext || "").replace(/\s+/g, " ").trim().slice(0, 120);

  return { headline, visual, highlight, subtext };
}

function escapeXml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function estimateTextWidth(text, fontSize, widthFactor = 0.56) {
  return String(text || "").length * fontSize * widthFactor;
}

function normalizeToken(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function getHighlightTerms(highlight, headline) {
  const stopWords = new Set([
    "the", "and", "for", "with", "that", "this", "from", "into", "your", "you",
    "are", "was", "were", "have", "has", "had", "not", "but", "out", "too", "just"
  ]);

  const seed = `${String(highlight || "")} ${String(headline || "")}`;
  const tokens = seed
    .split(/\s+/)
    .map((t) => normalizeToken(t))
    .filter((t) => t.length >= 4 && !stopWords.has(t));

  return Array.from(new Set(tokens)).slice(0, 6);
}

function pickFallbackHighlightTerm(lines) {
  const words = (Array.isArray(lines) ? lines.join(" ") : String(lines || ""))
    .split(/\s+/)
    .map((w) => normalizeToken(w))
    .filter((w) => w.length >= 5);

  if (!words.length) return "";
  words.sort((a, b) => b.length - a.length);
  return words[0];
}

function wrapText(text, maxWidthPx, fontSize, maxLines, widthFactor = 0.56) {
  const words = String(text || "").trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [];

  const lines = [];
  let current = "";
  const maxCharsChunk = Math.max(3, Math.floor(maxWidthPx / Math.max(1, fontSize * widthFactor)));

  for (const word of words) {
    if (estimateTextWidth(word, fontSize, widthFactor) > maxWidthPx) {
      const chunks = [];
      let source = word;
      while (source.length > maxCharsChunk) {
        chunks.push(source.slice(0, maxCharsChunk));
        source = source.slice(maxCharsChunk);
      }
      if (source) chunks.push(source);

      for (const chunk of chunks) {
        const nextChunk = current ? `${current} ${chunk}` : chunk;
        if (estimateTextWidth(nextChunk, fontSize, widthFactor) <= maxWidthPx) {
          current = nextChunk;
          continue;
        }
        if (current) {
          lines.push(current);
          if (lines.length >= maxLines) {
            lines[maxLines - 1] = `${lines[maxLines - 1].replace(/\.\.\.$/, "")}...`;
            return lines;
          }
        }
        current = chunk;
      }
      continue;
    }

    const next = current ? `${current} ${word}` : word;
    if (estimateTextWidth(next, fontSize, widthFactor) <= maxWidthPx) {
      current = next;
      continue;
    }

    if (current) {
      lines.push(current);
      if (lines.length >= maxLines) {
        lines[maxLines - 1] = `${lines[maxLines - 1].replace(/\.\.\.$/, "")}...`;
        return lines;
      }
    }
    current = word;
  }

  if (current && lines.length < maxLines) {
    lines.push(current);
  } else if (current && lines.length >= maxLines) {
    lines[maxLines - 1] = `${lines[maxLines - 1].replace(/\.\.\.$/, "")}...`;
  }

  return lines;
}

function fitOverlayLayout(width, height, imageConcept) {
  const left = Math.round(width * 0.08);
  const right = Math.round(width * 0.08);
  const maxWidth = Math.max(220, width - left - right);

  let headlineSize = Math.max(40, Math.round(width * 0.066));
  const minHeadlineSize = Math.max(28, Math.round(width * 0.034));

  while (headlineSize >= minHeadlineSize) {
    const subtextSize = Math.max(20, Math.round(headlineSize * 0.46));

    const headlineLines = wrapText(imageConcept.headline, maxWidth, headlineSize, 3, 0.62);
    const subtextLines = wrapText(imageConcept.subtext, maxWidth, subtextSize, 2, 0.54);
    const lineHeight = Math.round(headlineSize * 1.08);
    const overlayTop = Math.round(height * 0.62);
    const subLineHeight = Math.round(subtextSize * 1.24);
    const subtextStartY = overlayTop + (headlineLines.length * lineHeight) + Math.round(headlineSize * 0.65);
    const bottom = subtextStartY + Math.max(0, (subtextLines.length - 1) * subLineHeight);
    const maxBottom = height - Math.round(height * 0.08);

    const headFits = headlineLines.every((line) => estimateTextWidth(line, headlineSize, 0.62) <= maxWidth);
    const subFits = subtextLines.every((line) => estimateTextWidth(line, subtextSize, 0.54) <= maxWidth);
    const heightFits = bottom <= maxBottom;

    if (headFits && subFits && heightFits) {
      return {
        left,
        headlineSize,
        subtextSize,
        headlineLines,
        subtextLines,
        lineHeight,
        overlayTop,
        subtextStartY,
        subLineHeight,
      };
    }

    headlineSize -= 3;
  }

  const fallbackHeadlineSize = minHeadlineSize;
  return {
    left,
    headlineSize: fallbackHeadlineSize,
    subtextSize: Math.max(18, Math.round(fallbackHeadlineSize * 0.45)),
    headlineLines: wrapText(imageConcept.headline, maxWidth, fallbackHeadlineSize, 3, 0.62),
    subtextLines: wrapText(imageConcept.subtext, maxWidth, Math.max(18, Math.round(fallbackHeadlineSize * 0.45)), 2, 0.54),
    lineHeight: Math.round(fallbackHeadlineSize * 1.08),
    overlayTop: Math.round(height * 0.62),
    subtextStartY: Math.round(height * 0.62) + Math.round(fallbackHeadlineSize * 3.2),
    subLineHeight: Math.round(Math.max(18, Math.round(fallbackHeadlineSize * 0.45)) * 1.24),
  };
}

function buildHighlightedLineTspans(line, highlightTerms, forcedTerm = "") {
  const parts = String(line || "").match(/[A-Za-z0-9']+|[^A-Za-z0-9']+/g) || [];
  const termSet = new Set((highlightTerms || []).map((t) => normalizeToken(t)).filter(Boolean));
  const force = normalizeToken(forcedTerm);

  let matched = false;
  const svg = parts
    .map((part) => {
      const token = normalizeToken(part);
      if (!token) return `<tspan fill="#f8fafc">${escapeXml(part)}</tspan>`;

      const shouldHighlight = termSet.has(token) || (force && token === force);
      if (shouldHighlight) matched = true;
      const color = shouldHighlight ? "#fbbf24" : "#f8fafc";
      return `<tspan fill="${color}">${escapeXml(part)}</tspan>`;
    })
    .join("");

  return { svg, matched };
}

function buildOverlaySvg(width, height, imageConcept) {
  const layout = fitOverlayLayout(width, height, imageConcept);
  const {
    left,
    headlineSize,
    subtextSize,
    headlineLines,
    subtextLines,
    lineHeight,
    overlayTop,
    subtextStartY,
    subLineHeight,
  } = layout;

  const fontStack = "Inter, DejaVu Sans, Liberation Sans, Arial, sans-serif";

  const highlightTerms = getHighlightTerms(imageConcept.highlight, imageConcept.headline);
  const lineStates = headlineLines.map((line) => buildHighlightedLineTspans(line, highlightTerms));
  let hasHighlight = lineStates.some((state) => state.matched);

  if (!hasHighlight && headlineLines.length > 0) {
    const forced = pickFallbackHighlightTerm(headlineLines);
    if (forced) {
      lineStates[0] = buildHighlightedLineTspans(headlineLines[0], highlightTerms, forced);
      hasHighlight = lineStates[0].matched;
    }
  }

  const headlineShadowBlocks = headlineLines
    .map((line, index) => `<text x="${left + 2}" y="${overlayTop + (index * lineHeight) + 2}" font-family="${fontStack}" font-size="${headlineSize}" font-weight="800" fill="rgba(0,0,0,0.88)">${escapeXml(line)}</text>`)
    .join("");

  const headlineBlocks = headlineLines
    .map((line, index) => `<text x="${left}" y="${overlayTop + (index * lineHeight)}" font-family="${fontStack}" font-size="${headlineSize}" font-weight="800">${lineStates[index]?.svg || `<tspan fill="#f8fafc">${escapeXml(line)}</tspan>`}</text>`)
    .join("");

  const subtextShadowBlocks = subtextLines
    .map((line, index) => `<text x="${left + 1}" y="${subtextStartY + (index * subLineHeight) + 2}" font-family="${fontStack}" font-size="${subtextSize}" font-weight="500" fill="rgba(0,0,0,0.84)">${escapeXml(line)}</text>`)
    .join("");

  const subtextBlocks = subtextLines
    .map((line, index) => `<text x="${left}" y="${subtextStartY + (index * subLineHeight)}" font-family="${fontStack}" font-size="${subtextSize}" font-weight="500" fill="#e2e8f0">${escapeXml(line)}</text>`)
    .join("");

  return `
<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="fade" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="rgba(0,0,0,0.05)"/>
      <stop offset="55%" stop-color="rgba(0,0,0,0.58)"/>
      <stop offset="100%" stop-color="rgba(0,0,0,0.92)"/>
    </linearGradient>
  </defs>
  <rect x="0" y="0" width="${width}" height="${height}" fill="url(#fade)"/>
  ${headlineShadowBlocks}
  ${headlineBlocks}
  ${subtextShadowBlocks}
  ${subtextBlocks}
</svg>`;
}

async function renderImageWithText(backgroundImageUrl, imageConcept) {
  const response = await axios.get(backgroundImageUrl, {
    responseType: "arraybuffer",
    timeout: 45000,
  });

  const background = Buffer.from(response.data);
  const metadata = await sharp(background).metadata();
  const width = metadata.width || 1024;
  const height = metadata.height || 1024;

  const overlaySvg = buildOverlaySvg(width, height, imageConcept);
  const outputPath = path.join(os.tmpdir(), `shoro-render-${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`);

  await sharp(background)
    .composite([{ input: Buffer.from(overlaySvg), top: 0, left: 0 }])
    .jpeg({ quality: 92, mozjpeg: true })
    .toFile(outputPath);

  return outputPath;
}

function imageConceptToText(imageConcept) {
  return [
    `Headline: ${imageConcept.headline}`,
    `Highlight: ${imageConcept.highlight || "-"}`,
    `Subtext: ${imageConcept.subtext || "-"}`,
    `Visual: ${imageConcept.visual}`,
  ].join("\n");
}

// ─── 5. DATA FETCHING (Reddit & Hacker News) ────────────────────────────────

const REDDIT_HEADERS_BASE = {
  Accept: "application/json",
  "Accept-Language": "en-US,en;q=0.9",
  "Cache-Control": "no-cache",
};

async function fetchRedditSubOnce(sub, baseHost) {
  const url = `https://${baseHost}/r/${sub}/hot.json?limit=8&raw_json=1`;
  const res = await axios.get(url, {
    headers: { ...REDDIT_HEADERS_BASE, "User-Agent": randomAgent() },
    timeout: 12000,
    validateStatus: (s) => s < 500,
  });
  if (res.status !== 200 || !res.data?.data?.children) return [];
  return res.data.data.children
    .map((p) => p?.data?.title)
    .filter((t) => t && t.length > 20 && t.length < 200)
    .slice(0, 5)
    .map((t) => `[r/${sub}] ${t}`);
}

async function fetchRedditTrends(category) {
  const allTitles = [];
  const subs = getSubredditsForCategory(category);

  for (const sub of subs) {
    try {
      let batch = [];
      try {
        batch = await fetchRedditSubOnce(sub, "www.reddit.com");
      } catch (e) {
        console.warn(`Reddit www r/${sub}: ${e.message}`);
      }
      if (batch.length === 0) {
        try {
          batch = await fetchRedditSubOnce(sub, "old.reddit.com");
        } catch (e) {
          console.warn(`Reddit old r/${sub}: ${e.message}`);
        }
      }
      allTitles.push(...batch);
    } catch (err) {
      console.warn(`Reddit r/${sub} failed: ${err.message}`);
    }
    await sleep(450);
  }
  if (allTitles.length < 3) return null;
  console.log(`✅ Reddit: fetched ${allTitles.length} titles across ${subs.length} subs (${category || DEFAULT_CATEGORY})`);
  return allTitles.slice(0, 20).join("\n");
}

async function fetchHNTrends() {
  try {
    const sevenDaysAgo = Math.floor(Date.now() / 1000) - 7 * 24 * 60 * 60;
    const [askRes, storyRes] = await Promise.all([
      axios.get("https://hn.algolia.com/api/v1/search_by_date", {
        params: {
          tags: "ask_hn",
          hitsPerPage: 10,
          numericFilters: `points>10,created_at_i>${sevenDaysAgo}`,
        },
        headers: { "User-Agent": randomAgent() },
        timeout: 10000,
      }),
      axios.get("https://hn.algolia.com/api/v1/search_by_date", {
        params: {
          tags: "story",
          hitsPerPage: 8,
          numericFilters: `points>30,created_at_i>${sevenDaysAgo}`,
        },
        headers: { "User-Agent": randomAgent() },
        timeout: 10000,
      }),
    ]);

    const askTitles = (askRes?.data?.hits || [])
      .map((h) => h.title)
      .filter((t) => t && t.length > 15)
      .slice(0, 6)
      .map((t) => `[HN Ask] ${t}`);

    const storyTitles = (storyRes?.data?.hits || [])
      .map((h) => h.title)
      .filter((t) => t && t.length > 15)
      .slice(0, 5)
      .map((t) => `[HN] ${t}`);

    const titles = [...askTitles, ...storyTitles];
    if (titles.length < 2) return null;
    console.log(`✅ HN: fetched ${titles.length} titles`);
    return titles.join("\n");
  } catch (err) {
    console.warn(`HN fetch failed: ${err.message}`);
    return null;
  }
}

async function fetchLiveSignals(category) {
  const [reddit, hn] = await Promise.allSettled([
    fetchRedditTrends(category),
    fetchHNTrends(),
  ]);

  const parts = [];
  const sources = [];

  if (reddit.status === "fulfilled" && reddit.value) {
    parts.push(reddit.value);
    const subs = getSubredditsForCategory(category);
    sources.push("Reddit(" + subs.map((s) => `r/${s}`).join(",") + ")");
  }
  if (hn.status === "fulfilled" && hn.value) {
    parts.push(hn.value);
    sources.push("Hacker News");
  }

  if (parts.length === 0) return { data: null, source: "none" };
  return { data: parts.join("\n"), source: sources.join(" + ") };
}

// ─── 6. LLM API WRAPPERS (OpenRouter & OpenClaw) ────────────────────────────

function isTransient(err) {
  const msg = (err?.message || String(err)).toLowerCase();
  const code = (err?.code || "").toLowerCase();
  
  const keywords = [
    "503",
    "no healthy upstream",
    "provider returned error",
    "gateway timeout",
    "timed out",
    "timeout",
    "operation was aborted",
    "aborted",
    "cancel",
    "econnreset",
    "econnaborted",
    "err_canceled",
    "err_bad_gateway",
    "err_network",
    "response payload was empty",
    "returned no json payload",
    "socket hang up",
    "rate limit",
    "too many requests",
  ];
  
  return keywords.some(k => msg.includes(k) || code.includes(k));
}

async function callOpenRouterDirect(prompt) {
  if (!OR_API_KEY) throw new Error("OPENROUTER_API_KEY not set.");
  const res = await axios.post(
    "https://openrouter.ai/api/v1/chat/completions",
    {
      model: OR_MODEL,
      messages: [{ role: "user", content: prompt }],
      max_tokens: 1024,
      temperature: 0.7,
    },
    {
      headers: {
        Authorization: `Bearer ${OR_API_KEY}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://shoro-bot.local",
        "X-Title": "Shoro Bot",
      },
      timeout: 180000,
    }
  );
  const text = res.data?.choices?.[0]?.message?.content;
  if (!text) throw new Error("OpenRouter returned empty content");
  return text.trim();
}

// const OPENCLAW_MAIN = "C:\\Users\\BIT\\AppData\\Roaming\\npm\\node_modules\\openclaw\\openclaw.mjs";

async function callDirectWithRetry(prompt, logName) {
  let attempt = 0;
  while (attempt < OPENCLAW_MAX_RETRIES) {
    try {
      if (attempt > 0) {
        console.log(`🔄 [${logName}] Retrying OpenRouter request (attempt ${attempt + 1})...`);
        await sleep(2000 * attempt);
      }
      return await callOpenRouterDirect(prompt);
    } catch (e) {
      const msg = e.response?.data?.error?.message || e.message;
      console.warn(`⚠️ [${logName}] OpenRouter request failed: ${msg} (Code: ${e.code || "N/A"})`);
      
      if (isTransient(e)) {
        attempt++;
      } else {
        throw new Error(`OpenRouter ${logName} failed: ${msg}`);
      }
    }
  }
  throw new Error(`[${logName}] OpenRouter failed after ${OPENCLAW_MAX_RETRIES} transient errors.`);
}

function getAIResponse(prompt, sessionId) {
  return new Promise((resolve, reject) => {
    if (!OPENCLAW_MAIN) {
      return reject(new Error("OpenClaw executable not found. Set OPENCLAW_MAIN to the openclaw.mjs path."));
    }

    const parseStdout = (stdout, stderr, exitCode) => {
      const textOut = (stdout || "").trim();
      const jsonStart = textOut.lastIndexOf("{");
      if (jsonStart === -1) {
        return reject(new Error("OpenClaw returned no JSON payload. " + (stderr ? `stderr: ${String(stderr).slice(0, 800)}` : `exit ${exitCode}`)));
      }
      try {
        const parsed = JSON.parse(textOut.slice(jsonStart));
        const reply = parsed?.payloads?.[0]?.text || parsed?.text || parsed?.message;
        if (!reply?.trim()) {
          console.error("OpenClaw response payload was empty.");
          return reject(new Error("OpenClaw response payload was empty."));
        }
        resolve(reply.trim());
      } catch (e) {
        reject(new Error(`Failed to parse OpenClaw JSON: ${e.message}`));
      }
    };

    const freshSessionId = `fresh-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    const args = [
      OPENCLAW_MAIN,
      "agent",
      "--agent", "main",
      "--session-id", freshSessionId,
      "--json",
      "--message", "-",
    ];

    console.log(`🤖 [openclaw] Starting direct node session (non-interactive): ${freshSessionId}...`);

    const child = spawn("node", args, {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false, 
      env: { ...process.env, OPENCLAW_LOG_LEVEL: "info" }
    });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch (_) { }
      reject(new Error("OpenClaw timed out after 300s"));
    }, 300000); 

    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 && code !== null) {
        return reject(new Error(`Exit ${code}: ${stderr.slice(-500)}`));
      }
      parseStdout(stdout, stderr, code);
    });

    try {
      child.stdin.write(prompt, "utf8", () => {
        child.stdin.end();
      });
    } catch (e) {
      clearTimeout(timer);
      reject(new Error(`Failed to write prompt to stdin: ${e.message}`));
    }
  });
}

async function getAIResponseWithRetry(prompt, logName) {
  let attempt = 0;
  while (attempt < OPENCLAW_MAX_RETRIES) {
    try {
      if (attempt > 0) {
        console.log(`🔄 [${logName}] Retrying OpenClaw request (attempt ${attempt + 1})...`);
        await sleep(2000 * attempt);
      }
      return await getAIResponse(prompt);
    } catch (e) {
      console.warn(`⚠️ [${logName}] OpenClaw request failed: ${e.message}`);
      if (isTransient(e)) {
        attempt++;
      } else {
        throw e;
      }
    }
  }
  throw new Error(`[${logName}] OpenClaw failed after ${OPENCLAW_MAX_RETRIES} attempts.`);
}

// ─── 7. POST FORMATTING & VALIDATION ────────────────────────────────────────

function looksLikeMeta(text) {
  const m = (text || "").toLowerCase();
  return (
    m.includes("here is the post") ||
    m.includes("i have written") ||
    m.includes("here's a draft") ||
    m.includes("let me know")
  );
}

function looksLikeAnalysis(text) {
  const m = (text || "").toLowerCase();
  return m.includes("the story is about") || m.includes("the trend shows");
}

function looksLikeClarification(text) {
  const m = (text || "").toLowerCase();
  return m.includes("what is your timezone") || m.includes("how should i address you");
}

function enforcePostFormat(raw) {
  if (!raw) return raw;
  
  // Collapse excessive spacing (3+ newlines into 2)
  let processed = raw.replace(/\n{3,}/g, "\n\n").trim();
  
  const lines = processed.split("\n");
  let startIdx = 0;
  for (let i = 0; i < Math.min(lines.length, 3); i++) {
    if (looksLikeMeta(lines[i])) { startIdx = i + 1; }
  }
  return lines.slice(startIdx).join("\n").trim();
}

function assertPost(post, contextMsg) {
  if (!post || post.length < 50) {
    throw new Error(`Validation failed for ${contextMsg}: Output is too short or empty.`);
  }
  if (looksLikeMeta(post) || looksLikeClarification(post)) {
    throw new Error(`Validation failed for ${contextMsg}: Bot returned conversational meta-text instead of a post.`);
  }
}

// ─── 8. PIPELINES ───────────────────────────────────────────────────────────

async function runAutopostPipeline(category = null) {
  console.log(`🔍 Fetching live signals for autopost (Category: ${category || DEFAULT_CATEGORY})...`);
  const { data: rawSignals, source } = await fetchLiveSignals(category);

  if (!rawSignals) {
    throw new Error("All live signal sources failed. Cannot run autopost without real data.");
  }

  const cleanerPrompt = buildSignalCleanerPrompt(rawSignals);
  const signals = await callDirectWithRetry(cleanerPrompt, "signal-cleaner");
  
  logStage("LIVE_SIGNALS", signals);

  const pickerPrompt = buildStoryPickerPrompt(signals, source, recentTopics, category);
  const chosenStory = await callDirectWithRetry(pickerPrompt, "story-picker");

  if (!chosenStory?.trim() || chosenStory.trim().toUpperCase() === "SKIP") {
    throw new Error(`No qualifying ${category || DEFAULT_CATEGORY} story found in this week's signals.`);
  }

  logStage("CHOSEN_STORY", chosenStory);

  const painPrompt = buildPainPointExtractorPrompt(chosenStory.trim());
  const painPoint = await callDirectWithRetry(painPrompt, "pain-extractor");

  const writerPrompt = buildPostWriterPrompt(`${chosenStory.trim()}\nContext/Pain Point: ${painPoint}`);
  let rawPost = await callDirectWithRetry(writerPrompt, "post-writer");
  rawPost = enforcePostFormat(rawPost);

  const polisherPrompt = buildPostPolisherPrompt(rawPost);
  const post = await callDirectWithRetry(polisherPrompt, "post-polisher");

  console.log("🎨 Designing image concept...");
  const imageConceptPrompt = buildImageConceptPrompt(chosenStory.trim(), post);
  const imageConceptRaw = await callDirectWithRetry(imageConceptPrompt, "image-concept");
  const imageConcept = normalizeImageConcept(imageConceptRaw, chosenStory.trim());
  const imageBackgroundUrl = await callImageAPI(imageConcept.visual);
  const imageUrl = await renderImageWithText(imageBackgroundUrl, imageConcept);

  assertPost(post, "autopost");
  rememberTopic(chosenStory.trim());
  logStage("FINAL_POST", post);
  logStage("IMAGE_CONCEPT", imageConcept);
  return { post, source, chosenStory: chosenStory.trim(), imageUrl, imageConcept };
}

async function runGeneratePipeline() {
  return await runAutopostPipeline(DEFAULT_CATEGORY);
}

async function runTopicPostPipeline(topic) {
  console.log(`📝 Writing post for topic: ${topic}`);

  const painPrompt = buildPainPointExtractorPrompt(topic);
  const painPoint = await callDirectWithRetry(painPrompt, "pain-extractor-manual");

  const prompt = buildTopicPostPrompt(`${topic}\nContext/Pain Point: ${painPoint}`);
  let rawPost = await callDirectWithRetry(prompt, "topic-post");
  rawPost = enforcePostFormat(rawPost);

  const polisherPrompt = buildPostPolisherPrompt(rawPost);
  const post = await callDirectWithRetry(polisherPrompt, "topic-polisher");

  console.log("🎨 Designing image concept...");
  const imageConceptPrompt = buildImageConceptPrompt(topic, post);
  const imageConceptRaw = await callDirectWithRetry(imageConceptPrompt, "image-concept-manual");
  const imageConcept = normalizeImageConcept(imageConceptRaw, topic);
  const imageBackgroundUrl = await callImageAPI(imageConcept.visual);
  const imageUrl = await renderImageWithText(imageBackgroundUrl, imageConcept);

  assertPost(post, "topic-post");
  rememberTopic(topic);
  logStage("FINAL_POST", post);
  logStage("IMAGE_CONCEPT", imageConcept);
  return { post, imageUrl, imageConcept };
}

async function runResearchPipeline(topic) {
  console.log(`🚀 Starting Deep Research Content Brief for: "${topic}"`);
  
  const briefPrompt = [
    "I need a comprehensive content brief for a high-impact blog and social campaign.",
    `Topic: ${topic}`,
    "",
    "Research the web and deliver the brief using this EXACT format:",
    "## COMPETITOR ARTICLES",
    "| # | Title | URL | Angle | Gap |",
    "## SEARCH QUERIES",
    "## TARGET AUDIENCE",
    "## HEADLINE OPTIONS",
    "## RECOMMENDED OUTLINE",
    "## KEY STATS",
    "## SOCIAL POSTS",
    "## DISTRIBUTION"
  ].join("\n");

  const fullResponse = await getAIResponseWithRetry(briefPrompt, "content-brief-researcher");
  const socialSectionMatch = fullResponse.match(/## SOCIAL POSTS([\s\S]*?)(?=## DISTRIBUTION|$)/i);
  const socialPost = socialSectionMatch ? socialSectionMatch[1].trim() : "Social post generation failed.";
  const researchBrief = fullResponse.replace(/## SOCIAL POSTS[\s\S]*?(?=## DISTRIBUTION|$)/i, "✅ *Social Posts generated below*").trim();

  console.log("🎨 Designing image concept...");
  const imageConceptPrompt = buildImageConceptPrompt(topic, socialPost);
  const imageConceptRaw = await callDirectWithRetry(imageConceptPrompt, "image-concept-research");
  const imageConcept = normalizeImageConcept(imageConceptRaw, topic);
  const imageBackgroundUrl = await callImageAPI(imageConcept.visual);
  const imageUrl = await renderImageWithText(imageBackgroundUrl, imageConcept);

  rememberTopic(topic);
  logStage("CONTENT_BRIEF", researchBrief);
  
  return {
    post: socialPost,
    analysis: "📊 Content Brief Analysis Complete.",
    sources: researchBrief,
    imageUrl,
    imageConcept
  };
}

// ─── 9. TELEGRAM WEBHOOK ────────────────────────────────────────────────────

function clampText(text) {
  if (!text || text.length <= TELEGRAM_MAX_TEXT) return text;
  return text.slice(0, TELEGRAM_MAX_TEXT) + "\n\n[truncated]";
}

async function safeSendMessage(chatId, text) {
  try {
    await axios.post(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      chat_id: chatId,
      text,
    });
  } catch (err) {
    console.error(`Telegram send failed: ${err.message}`);
  }
}

async function sendPhoto(chatId, photoUrl, caption) {
  try {
    const isRemoteUrl = /^https?:\/\//i.test(String(photoUrl || ""));
    if (isRemoteUrl) {
      await axios.post(`https://api.telegram.org/bot${TOKEN}/sendPhoto`, {
        chat_id: chatId,
        photo: photoUrl,
        caption: clampText(caption)?.slice(0, TELEGRAM_MAX_CAPTION)
      });
      return;
    }

    const form = new FormData();
    form.append("chat_id", String(chatId));
    form.append("caption", clampText(caption)?.slice(0, TELEGRAM_MAX_CAPTION) || "");
    form.append("photo", fs.createReadStream(photoUrl));

    await axios.post(`https://api.telegram.org/bot${TOKEN}/sendPhoto`, form, {
      headers: form.getHeaders(),
      maxBodyLength: Infinity,
      timeout: 30000,
    });

    try {
      fs.unlink(photoUrl, () => {});
    } catch (_) { }
  } catch (err) {
    console.error(`Telegram sendPhoto failed: ${err.message}`);
    await safeSendMessage(chatId, `🖼️ Image: ${photoUrl}\n\n${caption}`);
  }
}

async function sendChunked(chatId, text) {
  const content = text || "";
  for (let i = 0; i < content.length; i += TELEGRAM_MAX_TEXT) {
    await safeSendMessage(chatId, content.slice(i, i + TELEGRAM_MAX_TEXT));
  }
}

app.post("/webhook", async (req, res) => {
  const message = req.body?.message;
  if (!message?.text) return res.sendStatus(200);

  const chatId = message.chat.id;
  const text = message.text.trim();

  res.sendStatus(200);

  (async () => {
    try {
      if (isProcessing) {
        await safeSendMessage(chatId, "⏳ Processing...");
        return;
      }
      isProcessing = true;

      if (text.toLowerCase() === "generate" || text.startsWith("/generate")) {
        await safeSendMessage(chatId, "⏳ Scanning startup signals, picking story, and writing post...");
        const { post, imageUrl, imageConcept } = await runGeneratePipeline();
        await sendPhoto(chatId, imageUrl, post);
        await safeSendMessage(chatId, `🧠 Visual Spec\n\n${imageConceptToText(imageConcept)}`);

      } else if (text.startsWith("/post ")) {
        const topic = text.replace("/post", "").trim();
        if (!topic) return safeSendMessage(chatId, "Usage: /post <topic>");
        await safeSendMessage(chatId, `⏳ Writing post about "${topic}"...`);
        const { post, imageUrl, imageConcept } = await runTopicPostPipeline(topic);
        await sendPhoto(chatId, imageUrl, post);
        await safeSendMessage(chatId, `🧠 Visual Spec\n\n${imageConceptToText(imageConcept)}`);

      } else if (text.startsWith("/research ")) {
        const goal = text.replace("/research", "").trim();
        if (!goal) return safeSendMessage(chatId, "Usage: /research <goal>");
        await safeSendMessage(chatId, `🚀 Researching "${goal}" autonomously...`);
        const result = await runResearchPipeline(goal);
        await sendPhoto(chatId, result.imageUrl, result.post);
        await safeSendMessage(chatId, `🧠 Visual Spec\n\n${imageConceptToText(result.imageConcept)}`);
        await safeSendMessage(chatId, `🔗 Sources:\n${result.sources}`);

      } else if (text.toLowerCase() === "autopost" || text.startsWith("/autopost")) {
        const args = text.split(" ").slice(1);
        const category = args[0] ? args[0].toLowerCase() : DEFAULT_CATEGORY;
        await safeSendMessage(chatId, `⏳ Fetching signals for ${category}...`);
        const { post, source, chosenStory, imageUrl, imageConcept } = await runAutopostPipeline(category);
        await safeSendMessage(chatId, `📡 Sources: ${source}\n🎯 Story: ${chosenStory}`);
        await sendPhoto(chatId, imageUrl, post);
        await safeSendMessage(chatId, `🧠 Visual Spec\n\n${imageConceptToText(imageConcept)}`);

      } else if (text.startsWith("/start") || text.startsWith("/help")) {
        await safeSendMessage(chatId, "Commands:\n/generate\n/autopost [cat]\n/post <topic>\n/research <goal>");
      }
    } catch (err) {
      await safeSendMessage(chatId, `❌ Error: ${err.message}`);
    } finally {
      isProcessing = false;
    }
  })();
});

app.get("/", (_req, res) => {
  res.json({ ok: true, service: "shoro-bot", status: "running" });
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, processing: isProcessing });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});