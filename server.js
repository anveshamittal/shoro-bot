"use strict";

require("dotenv").config({ override: true });

const express = require("express");
const axios = require("axios");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

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
const OPENCLAW_MAX_RETRIES = 3;
const RECENT_TOPICS_FILE = "recent_topics.json";
const RECENT_TOPICS_LIMIT = 10;
const OR_MODEL = process.env.OR_MODEL || "google/gemini-2.0-flash-lite-001";
const OR_API_KEY = process.env.OPENROUTER_API_KEY || "";

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
    "Follow these steps:",
    "1. Topic -> Headline (e.g., 'X does Y in Z time')",
    "2. Decide Tone (Controversial, Opinion, or Informational)",
    "3. Build Visual Concept (Subject, Emotion, Scene)",
    "",
    "OUTPUT FORMAT:",
    "Headline: [Punchy Headline]",
    "Visual: [Detailed description for image generator]",
    "",
    "No other text."
  ].join("\n");
}

async function callImageAPI(prompt) {
  console.log("🎨 Calling Pollinations.ai for image...");
  const cleanedPrompt = encodeURIComponent(prompt.replace(/[\n\r]/g, " ").trim());
  const seed = Math.floor(Math.random() * 1000000);
  return `https://image.pollinations.ai/prompt/${cleanedPrompt}?width=1024&height=1024&nologo=true&seed=${seed}`;
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
  const imageConcept = await callDirectWithRetry(imageConceptPrompt, "image-concept");
  const imageUrl = await callImageAPI(imageConcept);

  assertPost(post, "autopost");
  rememberTopic(chosenStory.trim());
  logStage("FINAL_POST", post);
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
  const imageConcept = await callDirectWithRetry(imageConceptPrompt, "image-concept-manual");
  const imageUrl = await callImageAPI(imageConcept);

  assertPost(post, "topic-post");
  rememberTopic(topic);
  logStage("FINAL_POST", post);
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
  const imageConcept = await callDirectWithRetry(imageConceptPrompt, "image-concept-research");
  const imageUrl = await callImageAPI(imageConcept);

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
    await axios.post(`https://api.telegram.org/bot${TOKEN}/sendPhoto`, {
      chat_id: chatId,
      photo: photoUrl,
      caption: clampText(caption),
      parse_mode: "Markdown"
    });
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
        await safeSendMessage(chatId, `🧠 **Visual Spec**\n\n${imageConcept}`);

      } else if (text.startsWith("/post ")) {
        const topic = text.replace("/post", "").trim();
        if (!topic) return safeSendMessage(chatId, "Usage: /post <topic>");
        await safeSendMessage(chatId, `⏳ Writing post about "${topic}"...`);
        const { post, imageUrl, imageConcept } = await runTopicPostPipeline(topic);
        await sendPhoto(chatId, imageUrl, post);
        await safeSendMessage(chatId, `🧠 **Visual Spec**\n\n${imageConcept}`);

      } else if (text.startsWith("/research ")) {
        const goal = text.replace("/research", "").trim();
        if (!goal) return safeSendMessage(chatId, "Usage: /research <goal>");
        await safeSendMessage(chatId, `🚀 Researching "${goal}" autonomously...`);
        const result = await runResearchPipeline(goal);
        await sendPhoto(chatId, result.imageUrl, result.post);
        await safeSendMessage(chatId, `🧠 **Visual Spec**\n\n${result.imageConcept}`);
        await safeSendMessage(chatId, `🔗 Sources:\n${result.sources}`);

      } else if (text.toLowerCase() === "autopost" || text.startsWith("/autopost")) {
        const args = text.split(" ").slice(1);
        const category = args[0] ? args[0].toLowerCase() : DEFAULT_CATEGORY;
        await safeSendMessage(chatId, `⏳ Fetching signals for ${category}...`);
        const { post, source, chosenStory, imageUrl, imageConcept } = await runAutopostPipeline(category);
        await safeSendMessage(chatId, `📡 Sources: ${source}\n🎯 Story: ${chosenStory}`);
        await sendPhoto(chatId, imageUrl, post);
        await safeSendMessage(chatId, `🧠 **Visual Spec**\n\n${imageConcept}`);

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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});