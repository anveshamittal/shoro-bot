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
let isPipelineRunning = false;

// Optimize sharp for production memory usage
sharp.cache(false);

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
const OPENCLAW_MAX_RETRIES = 5;
const RECENT_TOPICS_FILE = "recent_topics.json";
const RECENT_TOPICS_LIMIT = 10;
const OR_MODEL = process.env.OR_MODEL || "openai/gpt-4o-mini";
const OR_API_KEY = process.env.OPENROUTER_API_KEY || "";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_IMAGE_MODEL = process.env.OPENAI_IMAGE_MODEL || "dall-e-3";
const OPENAI_IMAGE_SIZE = process.env.OPENAI_IMAGE_SIZE || "1024x1024";
const FONT_PATH = path.join(os.tmpdir(), "overlay-font-anton.ttf");
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
  startup: ["startups", "entrepreneur", "SaaS", "business", "productivity", "ycombinator", "indiehackers", "soloentrepreneur"],
  edtech: ["edtech", "highereducation", "Teachers", "education", "learning", "onlinelearning", "instructionaldesign"],
  ai: ["artificial", "MachineLearning", "singularity", "LocalLLaMA", "ChatGPT", "OpenAI", "ClaudeAI", "StableDiffusion"],
  healthcare: ["healthtech", "medicine", "nursing", "healthcare", "digitalhealth", "biotech"],
  fintech: ["fintech", "personalfinance", "crypto", "investing", "banking", "payments", "wallstreetbets", "stocks", "finance", "etfs"],
  marketing: ["marketing", "socialmedia", "advertising", "copywriting", "growthhacking", "digitalmarketing", "contentmarketing"],
  news_general: ["worldnews", "news", "upliftingnews", "nottheonion"],
  current_affairs: ["geopolitics", "worldpolitics", "economics", "unitedkingdom", "europe"],
  dmv_edtech: ["jee", "UPSC", "Indian_Academia", "udemy", "edtech", "learnprogramming"],
  controversy: ["unpopularopinion", "changemyview", "TrueOffMyChest", "AmItheAsshole"],
  personal_growth: ["getdisciplined", "selfimprovement", "decidingtobebetter", "productivity"],
  humor: ["India", "IndianPeopleFacebook", "desimemes", "Damnthatsinteresting"]
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

// ─── FONT MANAGEMENT ───────────────────────────────────────────────────────

let _fontB64 = null;

async function ensureFont() {
  if (fs.existsSync(FONT_PATH)) return;
  try {
    console.log("📦 Downloading overlay font...");
    const res = await axios.get(
      "https://github.com/google/fonts/raw/main/ofl/anton/Anton-Regular.ttf",
      { responseType: "arraybuffer", timeout: 30000 }
    );
    fs.writeFileSync(FONT_PATH, Buffer.from(res.data));
    console.log("✅ Overlay font ready.");
  } catch (err) {
    console.warn(`⚠️ Could not download font: ${err.message}. Falling back to system fonts.`);
  }
}

function getFontB64() {
  if (!_fontB64 && fs.existsSync(FONT_PATH)) {
    try {
      _fontB64 = fs.readFileSync(FONT_PATH).toString("base64");
    } catch (err) {
      console.warn(`⚠️ Could not read font file: ${err.message}`);
    }
  }
  return _fontB64;
}

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

// AGENT 6 (new): ARGUMENT ARCHITECT (Converts pain-point insight into a JSON content blueprint)
function buildArgumentArchitectSystemPrompt() {
  return [
    "You are a narrative architect. You receive a raw insight about a founder topic and convert it into a structured content blueprint. Do not write any LinkedIn post. Only output a JSON object and nothing else — no preamble, no markdown backticks.",
    "",
    "Output format:",
    "{",
    '  "hook_type": "curiosity | contrarian | blunt",',
    '  "core_claim": "...",',
    '  "supporting_point": "...",',
    '  "specific_detail": "...",',
    '  "emotional_trigger": "...",',
    '  "ending_style": "open_loop | punchline | reflection"',
    "}"
  ].join("\n");
}

// AGENT 7 (new): DRAFT CRITIC (Diagnoses weaknesses in Draft 1 — does NOT rewrite)
function buildDraftCriticSystemPrompt() {
  return [
    "You are a brutally honest LinkedIn content critic. Your job is to diagnose weaknesses in a draft post written for founders. Do not rewrite the post. Only output a JSON object and nothing else — no preamble, no markdown backticks.",
    "",
    "Output format:",
    "{",
    '  "hook_strength": <1-10>,',
    '  "clarity_issues": ["..."],',
    '  "generic_phrases": ["..."],',
    '  "emotional_flatness": "...",',
    '  "specificity_score": <1-10>,',
    '  "rewrite_instructions": [',
    '    "...",',
    '    "..."',
    '  ]',
    "}",
    "",
    "Flag any of these automatically:",
    "- Phrases like \"here's what I learned\", \"this is your sign\", \"let that sink in\"",
    "- Em dashes used more than once",
    "- Rhetorical questions used more than once",
    "- Any line that gives generic advice without a specific detail",
    "- Hook that does not create a curiosity gap or make a bold claim"
  ].join("\n");
}

// AGENT 8: POST POLISHER (Final pass for rhythm and flow)
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
  const styles = [
    "CYBERPUNK / TECH-NOIR (Dark, neon, futuristic)",
    "MINIMALIST / ARCHITECTURAL (Clean lines, vast spaces, powerful geometry)",
    "SURREALIST / DREAM-LIKE (Impossible physics, floating objects, moody sky)",
    "VINTAGE EDITORIAL (1970s magazine style, grainy, warm, bold colors)",
    "GRITTY / INDUSTRIAL (Metal, steam, raw textures, dark shadows)",
    "EPIC CINEMATIC (Film-like scale, volumetric lighting, hyper-realistic)",
    "ELECTRIC / NEON VIBRANCE (Glow, high saturation, energy)",
    "NORDIC / CLEAN (Soft light, cold tones, high-end professional)",
    "VINTAGE SCI-FI (Retro-futurism, glowing computers, space-age)",
    "MODERNIST ABSTRACT (Shapes, depth, light-vs-dark, mystery)"
  ];
  const style = styles[Math.floor(Math.random() * styles.length)];

  return [
    "You are a Viral Poster Agent. Design a UNIQUE, high-impact LinkedIn infographic poster concept.",
    "",
    `MANDATORY ART STYLE: ${style}`,
    "",
    `TOPIC: ${topic}`,
    `POST CONTENT: ${post}`,
    "",
    "IMPORTANT VISUAL RULES (Dramatic Poster Background):",
    "- scene: Highly detailed, epic cinematic storytelling that visually represents the post topic.",
    "- metaphor: Invent a UNIQUE, dramatic visual metaphor based on the topic (e.g., climbing a crumbling ladder, a tiny ship in a massive storm, a glowing futuristic portal). DO NOT always use crossroads.",
    "- detail: Make the environment rich and complex (e.g., if it's about AI, show robotic elements; if it's about risk, show stormy/dark elements vs bright/future elements).",
    "- composition: Strong central subject, epic scale, clear negative space at the top and bottom for text overlay.",
    "- lighting: Dramatic cinematic lighting, glowing accents, volumetric fog, high contrast.",
    "IMPORTANT:",
    "- NO TEXT, no typography, no letters, no words, no UI panels, no floating labels.",
    "- The image must be a text-free, highly detailed background artwork.",
    "- no over-designed poster elements",
    "",
    "IMPORTANT TEXT OVERLAY RULES (Golden Rule: Image = Emotion, Text = Message):",
    "Generate structured text blocks for the poster layout:",
    "- hook: Big Hook for the top (e.g. 'KPMG JUST SAID IT OUT LOUD')",
    "- number: Core Claim for the middle (e.g. '2-3 YEARS')",
    "- contrast: Subtext or contrast to support the number (e.g. 'OF JOB LEFT')",
    "- cta: Call to action for the bottom (e.g. 'CHOOSE YOUR CAREER WISELY')",
    "",
    "Return ONLY valid JSON in exactly this shape:",
    '{"hook":"...","number":"...","contrast":"...","cta":"...","visual":"..."}',
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
  
  const hook = String(parsed.hook || "FOUNDER REALITY CHECK").replace(/\s+/g, " ").trim().slice(0, 100).toUpperCase();
  const number = String(parsed.number || "").replace(/\s+/g, " ").trim().slice(0, 40).toUpperCase();
  const contrast = String(parsed.contrast || "").replace(/\s+/g, " ").trim().slice(0, 80).toUpperCase();
  const cta = String(parsed.cta || "CHOOSE WISELY").replace(/\s+/g, " ").trim().slice(0, 60).toUpperCase();
  const visual = String(parsed.visual || `cinematic editorial portrait background, moody lighting, shallow depth of field, startup office atmosphere, no text elements`).replace(/\s+/g, " ").trim();

  return { hook, number, contrast, cta, visual };
}

function escapeXml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function estimateTextWidth(text, fontSize, widthFactor = 0.56) {
  return String(text || "").length * fontSize * widthFactor;
}

function normalizeToken(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function getHighlightTerms(highlight, headline) {
  // Deprecated, removed for layout engine
  return [];
}

function pickFallbackHighlightTerm(lines) {
  // Deprecated, removed for layout engine
  return "";
}

function getHighlightMode() {
  // Deprecated, removed for layout engine
  return "single_word";
}

function generatePangoMarkup(imageConcept, headlineSize, subtextSize, isShadow = false) {
  // Deprecated, removed for layout engine
  return "";
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

  const textWidth = Math.round(width * 0.92);
  const shadowOffset = Math.max(2, Math.round(width * 0.005));

  async function createTextBuffer(text, fontSize, color, isShadow) {
    if (!text) return null;
    const escaped = escapeXml(text);
    const textColor = isShadow ? "black" : color;
    const markup = `<span font="Anton ${fontSize}" letter_spacing="-1024" foreground="${textColor}">${escaped}</span>`;
    return sharp({
      text: {
        text: markup,
        width: textWidth,
        align: 'center',
        rgba: true,
        fontfile: FONT_PATH
      }
    }).png().toBuffer();
  }

  // 1. RANDOM SIZE SCALE
  const headlineScale = [0.055, 0.06, 0.065];
  const scale = headlineScale[Math.floor(Math.random() * headlineScale.length)];

  const hookSize = Math.round(width * (scale * 1.2)); 
  const numberSize = Math.round(width * (scale * 2.2));
  const contrastSize = Math.round(width * (scale * 0.9));
  const ctaSize = Math.round(width * (scale * 0.75));

  // 2. RANDOM COLOR PALETTE
  const palettes = [
    ["#fbbf24", "#ffffff"], // gold + white
    ["#3b82f6", "#ffffff"], // electric blue + white
    ["#10b981", "#ffffff"], // emerald green + white
    ["#ec4899", "#ffffff"], // neon pink + white
    ["#8b5cf6", "#ffffff"], // cyber purple + white
    ["#ef4444", "#ffffff"], // bold red + white
    ["#06b6d4", "#ffffff"], // cyan + white
    ["#f97316", "#ffffff"], // intense orange + white
  ];
  const [highlightColor, textColor] = palettes[Math.floor(Math.random() * palettes.length)];

  const hookBuf = await createTextBuffer(imageConcept.hook, hookSize, textColor, false);
  const hookShadow = await createTextBuffer(imageConcept.hook, hookSize, textColor, true);
  
  const numberBuf = await createTextBuffer(imageConcept.number, numberSize, highlightColor, false);
  const numberShadow = await createTextBuffer(imageConcept.number, numberSize, highlightColor, true);

  const contrastBuf = await createTextBuffer(imageConcept.contrast, contrastSize, textColor, false);
  const contrastShadow = await createTextBuffer(imageConcept.contrast, contrastSize, textColor, true);

  const ctaBuf = await createTextBuffer(imageConcept.cta, ctaSize, highlightColor, false);
  const ctaShadow = await createTextBuffer(imageConcept.cta, ctaSize, highlightColor, true);

  const hookMeta = hookBuf ? await sharp(hookBuf).metadata() : { height: 0, width: 0 };
  const numberMeta = numberBuf ? await sharp(numberBuf).metadata() : { height: 0, width: 0 };
  const contrastMeta = contrastBuf ? await sharp(contrastBuf).metadata() : { height: 0, width: 0 };
  const ctaMeta = ctaBuf ? await sharp(ctaBuf).metadata() : { height: 0, width: 0 };

  const gap = Math.round(height * 0.015);
  
  // Calculate total block height
  let totalHeight = 0;
  if (hookBuf) totalHeight += hookMeta.height + gap;
  if (numberBuf) totalHeight += numberMeta.height + gap;
  if (contrastBuf) totalHeight += contrastMeta.height + gap;
  if (ctaBuf) totalHeight += ctaMeta.height + gap;
  if (totalHeight > 0) totalHeight -= gap; // remove last gap

  // 3. RANDOM POSITION LOGIC (top, center, bottom)
  const positions = ["bottom", "center", "top"];
  const position = positions[Math.floor(Math.random() * positions.length)];
  
  const paddingY = Math.round(height * 0.08);

  let startY;
  if (position === "bottom") {
    startY = height - totalHeight - paddingY;
  } else if (position === "center") {
    startY = Math.round((height - totalHeight) / 2);
  } else {
    startY = paddingY;
  }

  const composites = [];
  
  let gradientSvg = "";
  if (position === "bottom") {
    gradientSvg = `
<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="fade" x1="0" y1="0" x2="0" y2="1">
      <stop offset="30%" stop-color="rgba(0,0,0,0)"/>
      <stop offset="100%" stop-color="rgba(0,0,0,0.85)"/>
    </linearGradient>
  </defs>
  <rect x="0" y="0" width="${width}" height="${height}" fill="url(#fade)"/>
</svg>`;
  } else if (position === "top") {
    gradientSvg = `
<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="fade" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="rgba(0,0,0,0.85)"/>
      <stop offset="70%" stop-color="rgba(0,0,0,0)"/>
    </linearGradient>
  </defs>
  <rect x="0" y="0" width="${width}" height="${height}" fill="url(#fade)"/>
</svg>`;
  } else {
    gradientSvg = `
<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
  <rect x="0" y="0" width="${width}" height="${height}" fill="rgba(0,0,0,0.4)"/>
</svg>`;
  }

  composites.push({ input: Buffer.from(gradientSvg), top: 0, left: 0 });

  let currentY = startY;
  const elements = [];
  
  if (hookBuf) {
    elements.push({ buf: hookBuf, shadow: hookShadow, y: currentY, meta: hookMeta });
    currentY += hookMeta.height + gap;
  }
  if (numberBuf) {
    elements.push({ buf: numberBuf, shadow: numberShadow, y: currentY, meta: numberMeta });
    currentY += numberMeta.height + gap;
  }
  if (contrastBuf) {
    elements.push({ buf: contrastBuf, shadow: contrastShadow, y: currentY, meta: contrastMeta });
    currentY += contrastMeta.height + gap;
  }
  if (ctaBuf) {
    elements.push({ buf: ctaBuf, shadow: ctaShadow, y: currentY, meta: ctaMeta });
  }

  for (const el of elements) {
    const left = Math.round((width - (el.meta.width || textWidth)) / 2);
    composites.push({ input: el.shadow, top: el.y + shadowOffset, left: left + shadowOffset });
    composites.push({ input: el.buf, top: el.y, left: left });
  }

  const outputPath = path.join(os.tmpdir(), `shoro-render-${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`);

  await sharp(background)
    .composite(composites)
    .jpeg({ quality: 92, mozjpeg: true })
    .toFile(outputPath);

  return outputPath;
}

function imageConceptToText(imageConcept) {
  return [
    `Hook: ${imageConcept.hook}`,
    `Number: ${imageConcept.number || "-"}`,
    `Contrast: ${imageConcept.contrast || "-"}`,
    `CTA: ${imageConcept.cta || "-"}`,
    `Visual: ${imageConcept.visual}`,
  ].join("\n");
}

// ─── 5. DATA FETCHING (Reddit & Hacker News) ────────────────────────────────

const REDDIT_HEADERS_BASE = {
  Accept: "application/json",
  "Accept-Language": "en-US,en;q=0.9",
  "Cache-Control": "no-cache",
};

async function fetchRedditSubOnce(sub, baseHost, type = "hot") {
  const url = `https://${baseHost}/r/${sub}/${type}.json?limit=10&raw_json=1`;
  const res = await axios.get(url, {
    headers: { ...REDDIT_HEADERS_BASE, "User-Agent": randomAgent() },
    timeout: 12000,
    validateStatus: (s) => s < 500,
  });
  if (res.status !== 200 || !res.data?.data?.children) return [];
  return res.data.data.children
    .map((p) => p?.data?.title)
    .filter((t) => t && t.length > 20 && t.length < 200)
    .slice(0, 8)
    .map((t) => `[r/${sub} ${type}] ${t}`);
}

async function fetchRedditTrends(category) {
  const allTitles = [];
  const subs = getSubredditsForCategory(category);

  for (const sub of subs) {
    try {
      // Try both HOT and NEW for each sub
      for (const type of ["hot", "new"]) {
        let batch = [];
        try {
          batch = await fetchRedditSubOnce(sub, "www.reddit.com", type);
        } catch (e) {
          try {
            batch = await fetchRedditSubOnce(sub, "api.reddit.com", type);
          } catch (e2) {
            try {
              batch = await fetchRedditSubOnce(sub, "old.reddit.com", type);
            } catch (e3) {
              console.warn(`Reddit r/${sub} ${type} failed all hosts.`);
            }
          }
        }
        allTitles.push(...batch);
      }
    } catch (err) {
      console.warn(`Reddit r/${sub} processing failed: ${err.message}`);
    }
    await sleep(350);
  }
  if (allTitles.length < 3) return null;
  console.log(`✅ Reddit: fetched ${allTitles.length} titles across ${subs.length} subs (${category || DEFAULT_CATEGORY})`);
  return allTitles.slice(0, 35).join("\n");
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
      temperature: 0.85,
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

/**
 * callOpenRouterWithModel — sends a system+user message pair to a specific model.
 * Used by Argument Architect (gpt-4o) and Draft Critic (claude-3.7-sonnet).
 */
async function callOpenRouterWithModel(model, systemPrompt, userMessage) {
  if (!OR_API_KEY) throw new Error("OPENROUTER_API_KEY not set.");
  const res = await axios.post(
    "https://openrouter.ai/api/v1/chat/completions",
    {
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
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
  if (!text) throw new Error(`OpenRouter (${model}) returned empty content`);
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
  if (isPipelineRunning) {
    console.log("⚠️ Pipeline already running. Skipping concurrent trigger.");
    return;
  }
  isPipelineRunning = true;
  try {
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

  logStage("PAIN_POINT", painPoint);

  // ── Argument Architect ────────────────────────────────────────────────────
  console.log("🏗️  [argument-architect] Building content blueprint...");
  let blueprint;
  try {
    const architectRaw = await callOpenRouterWithModel(
      "openai/gpt-4o",
      buildArgumentArchitectSystemPrompt(),
      painPoint
    );
    blueprint = extractFirstJsonObject(architectRaw);
    if (!blueprint) throw new Error("No valid JSON object found in Argument Architect response");
    logStage("ARGUMENT_BLUEPRINT", blueprint);
  } catch (err) {
    console.warn(`⚠️ [argument-architect] JSON parse failed, falling back to raw text: ${err.message}`);
    blueprint = painPoint; // raw-text fallback
  }

  // ── Post Writer — Draft 1 ─────────────────────────────────────────────────
  const blueprintInput = typeof blueprint === "string"
    ? `${chosenStory.trim()}\nContext/Pain Point: ${painPoint}\nBlueprint: ${blueprint}`
    : `${chosenStory.trim()}\nContext/Pain Point: ${painPoint}\nBlueprint: ${JSON.stringify(blueprint, null, 2)}`;

  const writerPrompt = buildPostWriterPrompt(blueprintInput);
  let draft1 = await callDirectWithRetry(writerPrompt, "post-writer-draft1");
  draft1 = enforcePostFormat(draft1);
  logStage("DRAFT_1", draft1);

  // ── Draft Critic ──────────────────────────────────────────────────────────
  console.log("🔍 [draft-critic] Analysing Draft 1...");
  let critiqueJson;
  try {
    const critiqueRaw = await callOpenRouterWithModel(
      "anthropic/claude-3.7-sonnet",
      buildDraftCriticSystemPrompt(),
      draft1
    );
    critiqueJson = extractFirstJsonObject(critiqueRaw);
    if (!critiqueJson) throw new Error("No valid JSON object found in Draft Critic response");
    logStage("DRAFT_CRITIQUE", critiqueJson);
  } catch (err) {
    console.warn(`⚠️ [draft-critic] JSON parse failed, falling back to raw text: ${err.message}`);
    critiqueJson = null;
  }

  // ── Post Writer — Draft 2 ─────────────────────────────────────────────────
  const postWriterSystemPrompt = buildPostWriterPrompt("").split("\n").slice(0, 3).join("\n"); // system context hint
  const draft2UserPrompt = [
    "You are rewriting a LinkedIn post based on a critique.",
    "",
    "Here is the original draft:",
    draft1,
    "",
    "Here is the critique:",
    critiqueJson ? JSON.stringify(critiqueJson, null, 2) : "(No structured critique available — improve the hook, remove generic phrases, and tighten the ending.)",
    "",
    "Rewrite the post by fixing every issue listed in rewrite_instructions. Rules:",
    "- Keep the same core idea and insight",
    "- Do not change the fundamental angle",
    "- Fix the hook first",
    "- Replace every flagged generic phrase with a specific detail",
    "- Do not add any new generic advice",
    "- Output only the rewritten post, no explanation"
  ].join("\n");

  let rawPost = await callDirectWithRetry(draft2UserPrompt, "post-writer-draft2");
  rawPost = enforcePostFormat(rawPost);
  logStage("DRAFT_2", rawPost);

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
  } finally {
    isPipelineRunning = false;
  }
}

async function runGeneratePipeline() {
  return await runAutopostPipeline(DEFAULT_CATEGORY);
}

async function runTopicPostPipeline(topic) {
  console.log(`📝 Writing post for topic: ${topic}`);

  const painPrompt = buildPainPointExtractorPrompt(topic);
  const painPoint = await callDirectWithRetry(painPrompt, "pain-extractor-manual");

  logStage("PAIN_POINT", painPoint);

  // ── Argument Architect ────────────────────────────────────────────────────
  console.log("🏗️  [argument-architect] Building content blueprint...");
  let blueprint;
  try {
    const architectRaw = await callOpenRouterWithModel(
      "openai/gpt-4o",
      buildArgumentArchitectSystemPrompt(),
      painPoint
    );
    blueprint = extractFirstJsonObject(architectRaw);
    if (!blueprint) throw new Error("No valid JSON object found in Argument Architect response");
    logStage("ARGUMENT_BLUEPRINT", blueprint);
  } catch (err) {
    console.warn(`⚠️ [argument-architect] JSON parse failed, falling back to raw text: ${err.message}`);
    blueprint = painPoint;
  }

  // ── Post Writer — Draft 1 ─────────────────────────────────────────────────
  const blueprintInput = typeof blueprint === "string"
    ? `${topic}\nContext/Pain Point: ${painPoint}\nBlueprint: ${blueprint}`
    : `${topic}\nContext/Pain Point: ${painPoint}\nBlueprint: ${JSON.stringify(blueprint, null, 2)}`;

  const draft1Prompt = buildTopicPostPrompt(blueprintInput);
  let draft1 = await callDirectWithRetry(draft1Prompt, "topic-post-draft1");
  draft1 = enforcePostFormat(draft1);
  logStage("DRAFT_1", draft1);

  // ── Draft Critic ──────────────────────────────────────────────────────────
  console.log("🔍 [draft-critic] Analysing Draft 1...");
  let critiqueJson;
  try {
    const critiqueRaw = await callOpenRouterWithModel(
      "anthropic/claude-3.7-sonnet",
      buildDraftCriticSystemPrompt(),
      draft1
    );
    critiqueJson = extractFirstJsonObject(critiqueRaw);
    if (!critiqueJson) throw new Error("No valid JSON object found in Draft Critic response");
    logStage("DRAFT_CRITIQUE", critiqueJson);
  } catch (err) {
    console.warn(`⚠️ [draft-critic] JSON parse failed, falling back to raw text: ${err.message}`);
    critiqueJson = null;
  }

  // ── Post Writer — Draft 2 ─────────────────────────────────────────────────
  const draft2UserPrompt = [
    "You are rewriting a LinkedIn post based on a critique.",
    "",
    "Here is the original draft:",
    draft1,
    "",
    "Here is the critique:",
    critiqueJson ? JSON.stringify(critiqueJson, null, 2) : "(No structured critique available — improve the hook, remove generic phrases, and tighten the ending.)",
    "",
    "Rewrite the post by fixing every issue listed in rewrite_instructions. Rules:",
    "- Keep the same core idea and insight",
    "- Do not change the fundamental angle",
    "- Fix the hook first",
    "- Replace every flagged generic phrase with a specific detail",
    "- Do not add any new generic advice",
    "- Output only the rewritten post, no explanation"
  ].join("\n");

  let rawPost = await callDirectWithRetry(draft2UserPrompt, "topic-post-draft2");
  rawPost = enforcePostFormat(rawPost);
  logStage("DRAFT_2", rawPost);

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

async function sendChunked(chatId, text) {
  const content = text || "";
  for (let i = 0; i < content.length; i += TELEGRAM_MAX_TEXT) {
    await safeSendMessage(chatId, content.slice(i, i + TELEGRAM_MAX_TEXT));
  }
}

async function sendPhoto(chatId, photoUrl, caption) {
  try {
    const textStr = String(caption || "");
    const captionToUse = textStr.length <= TELEGRAM_MAX_CAPTION ? textStr : "";

    const isRemoteUrl = /^https?:\/\//i.test(String(photoUrl || ""));
    if (isRemoteUrl) {
      await axios.post(`https://api.telegram.org/bot${TOKEN}/sendPhoto`, {
        chat_id: chatId,
        photo: photoUrl,
        caption: captionToUse
      });
    } else {
      const form = new FormData();
      form.append("chat_id", String(chatId));
      form.append("caption", captionToUse);
      form.append("photo", fs.createReadStream(photoUrl));

      await axios.post(`https://api.telegram.org/bot${TOKEN}/sendPhoto`, form, {
        headers: form.getHeaders(),
        maxBodyLength: Infinity,
        timeout: 30000,
      });

      try {
        fs.unlink(photoUrl, () => {});
      } catch (_) { }
    }

    // If the text is too long for a caption, send it as a separate full message
    if (textStr.length > TELEGRAM_MAX_CAPTION) {
      await sendChunked(chatId, textStr);
    }
  } catch (err) {
    console.error(`Telegram sendPhoto failed: ${err.message}`);
    await sendChunked(chatId, `🖼️ Image: ${photoUrl}\n\n${caption}`);
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

      } else if (text.startsWith("/hooks ") || text === "/hooks") {
        // Usage: /hooks [region] [category]
        // Example: /hooks India startup
        const args = text.replace("/hooks", "").trim().split(" ");
        const region = args[0] || "India";
        const category = args[1] || DEFAULT_CATEGORY;
        await safeSendMessage(chatId, `⏳ Running 8-agent hook pipeline for ${region} / ${category}...`);
        const { hooks, source, topics } = await runHookPipeline({ region, category });
        await safeSendMessage(chatId, `📡 Source: ${source}\n🎯 Topics: ${topics.join(", ")}\n📊 ${hooks.length} hooks generated`);
        // Send a sample of hooks (first 5) as a preview
        const preview = hooks.slice(0, 5).map(h =>
          `[${h.category} / ${h.hook_type}]\n${h.text}`
        ).join("\n\n---\n\n");
        await sendChunked(chatId, preview);

      } else if (text.startsWith("/hooktopic ")) {
        // Usage: /hooktopic <topic> | <region>
        // Example: /hooktopic Zepto raises $300M | India
        const parts = text.replace("/hooktopic", "").trim().split("|");
        const topic = parts[0]?.trim();
        const region = parts[1]?.trim() || "India";
        if (!topic) return safeSendMessage(chatId, "Usage: /hooktopic <topic> | <region>");
        await safeSendMessage(chatId, `⏳ Running 8 hook agents for: "${topic}" (${region})...`);
        const hooks = await runHookAgentsForTopic(topic, region, "general");
        const preview = hooks.slice(0, 6).map(h =>
          `[${h.category} / ${h.hook_type}]\n${h.text}`
        ).join("\n\n---\n\n");
        await sendChunked(chatId, preview);

      } else if (text.toLowerCase() === "autopost" || text.startsWith("/autopost")) {
        const args = text.split(" ").slice(1);
        const category = args[0] ? args[0].toLowerCase() : DEFAULT_CATEGORY;
        await safeSendMessage(chatId, `⏳ Fetching signals for ${category}...`);
        const { post, source, chosenStory, imageUrl, imageConcept } = await runAutopostPipeline(category);
        await safeSendMessage(chatId, `📡 Sources: ${source}\n🎯 Story: ${chosenStory}`);
        await sendPhoto(chatId, imageUrl, post);
        await safeSendMessage(chatId, `🧠 Visual Spec\n\n${imageConceptToText(imageConcept)}`);

      } else if (text.startsWith("/start") || text.startsWith("/help")) {
        await safeSendMessage(chatId, "Commands:\n/generate\n/autopost [cat]\n/post <topic>\n/research <goal>\n/hooks [region] [category] — Run 8-agent hook pipeline\n/hooktopic <topic> | <region> — Run hooks for a specific topic");
      }
    } catch (err) {
      await safeSendMessage(chatId, `❌ Error: ${err.message}`);
    } finally {
      isProcessing = false;
    }
  })();
});

// ─── 10. HOOK PIPELINE ──────────────────────────────────────────────────────

// Step 2 — Region Prefix Helper
function getRegionPrefix(region) {
  const map = {
    US: "This startup/event is from the US. ",
    Canada: "This startup/event is from Canada. ",
    Global: "This story spans multiple countries globally. ",
    India: ""
  };
  return map[region] || "";
}

// Step 3 — 8 Agent Prompt Builders

// Agent 1 — News General
function buildNewsGeneralHooksPrompt(topic, region) {
  return [
    `You are a social media content writer for a general audience.`,
    `Topic: ${topic}`,
    `Region: ${region}`,
    ``,
    `Write 3 short emotional hooks (2–3 lines each, LinkedIn style, personal-sounding) about this topic.`,
    `Hook 1: about FAILURE — emotion_type: sadness`,
    `Hook 2: about a SMALL WIN — emotion_type: hope`,
    `Hook 3: about a LESSON — emotion_type: inspiration`,
    ``,
    `Output ONLY a JSON array of exactly 3 objects. No markdown. No preamble. No explanation.`,
    `Schema for each object:`,
    `{ "hook_type": "<failure|small_win|lesson>", "platform": "LinkedIn", "text": "...", "emotion_type": "<sadness|hope|inspiration>", "hook_style": "standard" }`,
  ].join("\n");
}

// Agent 2 — Current Affairs
function buildCurrentAffairsHooksPrompt(topic, region) {
  return [
    `You are a serious content writer for educated, globally aware readers.`,
    `Topic: ${topic}`,
    `Region: ${region}`,
    ``,
    `Write 3 nuanced, serious hooks (LinkedIn style) about this topic:`,
    `Hook 1: about SYSTEMIC RISK — emotion_type: fear`,
    `Hook 2: about INSTITUTIONAL FAILURE — emotion_type: anger`,
    `Hook 3: about PERSONAL IMPACT OR LEARNING — emotion_type: curiosity`,
    ``,
    `Output ONLY a JSON array of exactly 3 objects. No markdown. No preamble. No explanation.`,
    `Schema for each object:`,
    `{ "hook_type": "<systemic_risk|institutional_failure|personal_impact>", "platform": "LinkedIn", "text": "...", "emotion_type": "<fear|anger|curiosity>", "hook_style": "standard" }`,
  ].join("\n");
}

// Agent 3 — DMV / EdTech
function buildDmvEdtechHooksPrompt(topic, region) {
  return [
    `You are a content writer for students, exam aspirants, parents, and edtech users.`,
    `Topic: ${topic}`,
    `Region: ${region}`,
    ``,
    `Write 3 emotional story-style hooks (LinkedIn style) about this topic:`,
    `Hook 1: about FAILURE — emotion_type: sadness`,
    `Hook 2: about FINAL PASS / SUCCESS — emotion_type: pride`,
    `Hook 3: about a LESSON LEARNED — emotion_type: inspiration`,
    ``,
    `Output ONLY a JSON array of exactly 3 objects. No markdown. No preamble. No explanation.`,
    `Schema for each object:`,
    `{ "hook_type": "<failure|final_pass|lesson>", "platform": "LinkedIn", "text": "...", "emotion_type": "<sadness|pride|inspiration>", "hook_style": "standard" }`,
  ].join("\n");
}

// Agent 4 — Startup News
function buildStartupNewsHooksPrompt(topic, region) {
  return [
    `You are a content writer for founders, operators, and investors.`,
    `Topic: ${topic}`,
    `Region: ${region}`,
    ``,
    `Write 3 LinkedIn hooks about this startup/business topic:`,
    `Hook 1: OPTIMISTIC / HYPE angle — hook_type: "optimistic", emotion_type: hope`,
    `Hook 2: SKEPTICAL / WARNING angle — hook_type: "skeptical", emotion_type: fear`,
    `Hook 3: LESSON FOR FOUNDERS — hook_type: "lesson", emotion_type: inspiration`,
    ``,
    `Output ONLY a JSON array of exactly 3 objects. No markdown. No preamble. No explanation.`,
    `Schema for each object:`,
    `{ "hook_type": "<optimistic|skeptical|lesson>", "platform": "LinkedIn", "text": "...", "emotion_type": "<hope|fear|inspiration>", "hook_style": "standard" }`,
  ].join("\n");
}

// Agent 5 — Controversy
function buildControversyHooksPrompt(topic, region) {
  return [
    `You are a hot-take content writer for debate-lovers and strong-opinion holders on X (Twitter).`,
    `Topic: ${topic}`,
    `Region: ${region}`,
    ``,
    `Write 3 X (Twitter) hooks showing an emotional arc: anger → regret → realization.`,
    `Hook 1: ANGER take — emotion_type: anger`,
    `Hook 2: REGRET / SADNESS take — emotion_type: sadness`,
    `Hook 3: REALIZATION / NUANCE — emotion_type: curiosity`,
    ``,
    `Output ONLY a JSON array of exactly 3 objects. No markdown. No preamble. No explanation.`,
    `Schema for each object:`,
    `{ "hook_type": "<anger|regret|realization>", "platform": "X", "text": "...", "emotion_type": "<anger|sadness|curiosity>", "hook_style": "standard" }`,
  ].join("\n");
}

// Agent 6 — Personal Growth
function buildPersonalGrowthHooksPrompt(topic, region) {
  return [
    `You are a reflective content writer for professionals, ambitious people, and founders on LinkedIn.`,
    `Topic: ${topic}`,
    `Region: ${region}`,
    ``,
    `Write 3 reflective, emotional LinkedIn hooks following the arc: past pain → insight → advice.`,
    `Hook 1: PAST PAIN — emotion_type: sadness`,
    `Hook 2: INSIGHT / TURNING POINT — emotion_type: hope`,
    `Hook 3: ADVICE / LESSON — emotion_type: inspiration`,
    ``,
    `Output ONLY a JSON array of exactly 3 objects. No markdown. No preamble. No explanation.`,
    `Schema for each object:`,
    `{ "hook_type": "<past_pain|insight|advice>", "platform": "LinkedIn", "text": "...", "emotion_type": "<sadness|hope|inspiration>", "hook_style": "standard" }`,
  ].join("\n");
}

// Agent 7 — Humor / Spicy
function buildHumorSpicyHooksPrompt(topic, region) {
  return [
    `You are a meme-aware, edgy content writer for X (Twitter) users who love viral and weird angles.`,
    `Topic: ${topic}`,
    `Region: ${region}`,
    ``,
    `Write 3 funny, meme-style, edgy X hooks about this topic. All 3 must use hook_style: "meme_spicy".`,
    `All emotion_type must be: humor.`,
    ``,
    `Output ONLY a JSON array of exactly 3 objects. No markdown. No preamble. No explanation.`,
    `Schema for each object:`,
    `{ "hook_type": "meme_spicy", "platform": "X", "text": "...", "emotion_type": "humor", "hook_style": "meme_spicy" }`,
  ].join("\n");
}

// Agent 8 — LinkedIn Safe
function buildLinkedinSafeHooksPrompt(topic, region) {
  return [
    `You are a polished content writer for senior professionals and corporate LinkedIn audiences.`,
    `Topic: ${topic}`,
    `Region: ${region}`,
    ``,
    `Write 3 calm, emotionally intelligent, professional LinkedIn hooks about this topic.`,
    `No slang, no extreme opinions, no clickbait. Tone: thoughtful, credible, confident.`,
    `Hook 1: emotion_type: pride`,
    `Hook 2: emotion_type: inspiration`,
    `Hook 3: emotion_type: curiosity`,
    ``,
    `Output ONLY a JSON array of exactly 3 objects. No markdown. No preamble. No explanation.`,
    `Schema for each object:`,
    `{ "hook_type": "<pride_moment|inspiration|curiosity>", "platform": "LinkedIn", "text": "...", "emotion_type": "<pride|inspiration|curiosity>", "hook_style": "standard" }`,
  ].join("\n");
}

// Step 4 — Central Hook Runner
async function runHookAgentsForTopic(topic, region, category) {
  const prefix = getRegionPrefix(region);
  const fullTopic = prefix + topic;

  const agentBuilders = [
    { name: "news_general",         fn: buildNewsGeneralHooksPrompt },
    { name: "news_current_affairs", fn: buildCurrentAffairsHooksPrompt },
    { name: "news_dmv_edtech",      fn: buildDmvEdtechHooksPrompt },
    { name: "startup_news",         fn: buildStartupNewsHooksPrompt },
    { name: "controversy_agent",    fn: buildControversyHooksPrompt },
    { name: "personal_growth",      fn: buildPersonalGrowthHooksPrompt },
    { name: "humor_spicy",          fn: buildHumorSpicyHooksPrompt },
    { name: "linkedin_safe",        fn: buildLinkedinSafeHooksPrompt },
  ];

  const results = [];

  for (const { name, fn } of agentBuilders) {
    try {
      console.log(`🔍 [hook-runner] Running agent: ${name}`);
      const raw = await callDirectWithRetry(fn(fullTopic, region), name);
      let parsed;
      try { parsed = JSON.parse(raw); } catch { parsed = extractFirstJsonObject(raw); }
      const hooksArray = Array.isArray(parsed) ? parsed : (parsed ? [parsed] : []);
      for (const hook of hooksArray) {
        results.push({
          category: name,
          topic,
          region,
          date: new Date().toISOString().split("T")[0],
          platform: hook.platform || "LinkedIn",
          hook_type: hook.hook_type || "general",
          text: hook.text || "",
          emotion_type: hook.emotion_type || "inspiration",
          hook_style: hook.hook_style || "standard",
        });
      }
      logStage(`HOOK_AGENT:${name}`, `${hooksArray.length} hooks generated`);
    } catch (err) {
      console.warn(`⚠️ [${name}] Hook agent failed: ${err.message}`);
    }
  }

  return results;
}

// Step 5 — Topic Research for Hook Pipeline
async function runHookPipeline({ region = "India", category = "startup", agentFilter = "all" }) {
  const { data: rawSignals, source } = await fetchLiveSignals(category);
  if (!rawSignals) throw new Error("No live signals available for hook pipeline.");

  console.log(`🔍 [hook-pipeline] Cleaning signals for category: ${category}`);
  const cleanerPrompt = buildSignalCleanerPrompt(rawSignals);
  const signals = await callDirectWithRetry(cleanerPrompt, "hook-signal-cleaner");

  // Pick top 3 topics instead of just 1
  const topicPickerPrompt = [
    `You are a topic selector for a social media content pipeline.`,
    `From the signals below, pick the TOP 3 most interesting topics for a ${category} audience.`,
    `Region: ${region}`,
    `Output ONLY a JSON array of 3 strings, each being a short topic title.`,
    `No explanation. No markdown. JSON only.`,
    `Example: ["Topic A", "Topic B", "Topic C"]`,
    `Signals:\n${signals}`
  ].join("\n");

  console.log(`🔍 [hook-pipeline] Picking top 3 topics...`);
  const rawTopics = await callDirectWithRetry(topicPickerPrompt, "hook-topic-picker");
  let topics;
  try {
    topics = JSON.parse(rawTopics);
    if (!Array.isArray(topics)) throw new Error("Not an array");
  } catch {
    topics = [rawTopics.trim()]; // fallback: treat whole output as one topic
  }

  logStage("HOOK_TOPICS", topics);

  const allHooks = [];
  for (const topic of topics.slice(0, 3)) {
    console.log(`🔍 [hook-pipeline] Running all 8 agents for topic: "${topic}"`);
    const hooks = await runHookAgentsForTopic(topic, region, category);
    allHooks.push(...hooks);
    rememberTopic(topic);
  }

  logStage("HOOK_PIPELINE_COMPLETE", `${allHooks.length} total hooks generated across ${topics.length} topics`);
  return { hooks: allHooks, source, topics };
}

// Step 7 — HTTP Endpoints for Hook Pipeline
app.post("/generate-hooks", async (req, res) => {
  const { region = "India", category = "startup", agent = "all" } = req.body || {};
  try {
    const result = await runHookPipeline({ region, category, agentFilter: agent });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/generate-hooks/test", async (req, res) => {
  // Runs one hardcoded topic through all 8 agents — for testing without hitting live APIs
  const testTopic = "India's NEET exam results spark protests across 10 cities";
  try {
    const hooks = await runHookAgentsForTopic(testTopic, "India", "dmv_edtech");
    res.json({ ok: true, hooks });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/", (_req, res) => {
  res.json({ ok: true, service: "shoro-bot", status: "running" });
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, processing: isProcessing });
});

ensureFont().then(() => {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
}).catch((err) => {
  console.error("Fatal error during startup:", err);
  process.exit(1);
});