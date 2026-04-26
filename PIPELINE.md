# LinkedIn Post Generation Pipeline - Architecture & Fixes

## Pipeline Overview

The bot generates founder-voice LinkedIn posts through a series of **AI agents**, each with a specific role and prompt. The pipeline is orchestrated by `buildLinkedInPostPipeline()` starting at line 1109.

---

## Agent Stages (In Order)

### 1. **Trend Discovery Agent** (Lines 249-267)
**Role**: Surface real founder discussions from live sources or AI-grounded trends  
**Inputs**: Niche focus, today's date  
**Prompt**: Instructs Claude to act as a founder scrolling Reddit/Twitter/Slack and list 10 REAL discussion titles  
**Output**: 10 specific, raw founder discussion titles  
**Fallback**: LLM-grounded trends if live sources fail  

**Live Sources** (tried in parallel):
- Reddit: r/Entrepreneur, r/startups, r/SaaS (via old.reddit fallback if www fails)
- Hacker News: Ask HN + top stories from past 7 days
- ProductHunt: trending products (most likely to 403)

---

### 2. **Hot Topic Selection Agent** (Lines 279-318)
**Role**: Pick the single most engaging discussion to build post around  
**Inputs**: Trend data + list of recent topics to avoid  
**Prompt**: "You are a viral content strategist... pick the ONE discussion that would make the most engaging post"  
**Output Format**:
```
HOT_TOPIC: [exact discussion or sharp reframe]
ANGLE: [specific contrarian insight to take]
WHY_NOW: [why this resonates THIS week]
HOOK_SEED: [emotional core or surprising fact]
```
**Fallback**: `fallbackHotTopicFromTrends()` selects first NON-GARBAGE topic from trend list  
**Fix Applied** (new): Fallback now filters out garbage (episodes, AMAs, podcasts) before selecting

---

### 3. **Topic Cleaner Agent** (Lines 1207-1232)
**Role**: Remove URLs/meta/noise while preserving specific insights  
**Inputs**: Raw selected topic  
**Prompt**: "Preserve the SPECIFIC insight. Do NOT abstract to generic category"  
**Output**: Cleaned topic (1 line, max ~120 chars)  
**Fallback**: Uses `fallbackCleanTopic()` which converts garbage patterns to founder-relevant problems  

---

### 4. **Topic Dedupe Check** (Lines 1234-1273)
**Role**: Prevent repeated topics in rapid-fire autopost mode  
**Logic**: If selected topic matches a recent topic (normalized), regenerate fresh one  
**Max Attempts**: 3  
**Fix Applied** (new): Now only re-cleans topic if it's garbage, not if it's good

---

### 5. **Pain Points Agent** (Lines 1288-1300)
**Role**: Extract 6 founder-voice quotes/statements about the topic  
**Inputs**: Clean topic, angle  
**Prompt**: "Write 6 things founders have actually SAID... first person, past tense, specific"  
**Output**: 6 raw, emotion-laden founder quotes (no labels)  
**Fallback**: `generateFallbackPainPoints()` creates deterministic statements derived from topic  

---

### 6. **Hook Generation Agent** (Lines 1302-1314)
**Role**: Create 5 scroll-stopping opening lines  
**Inputs**: Topic, hook seed, why-now context, pain points  
**Prompt**: "Your hooks stop founders mid-scroll... 2 lines max, creates curiosity gap"  
**Output**: 5 hooks, no numbering/labels  
**Fallback**: `generateFallbackHooks()` creates deterministic hooks derived from topic+angle  

---

### 7. **Best Hook Selection Agent** (Lines 1316-1330)
**Role**: Pick strongest hook from generated set  
**Inputs**: 5 hooks  
**Prompt**: "Pick the single strongest hook... Most surprising + creates max curiosity gap"  
**Output**: `HOOK: <selected hook>`  
**Fallback**: `pickBestHookFromList()` deterministically selects first hook  

---

### 8. **Final Writer Agent** (Lines 1332-1370)
**Role**: Write the actual LinkedIn post body  
**Inputs**: Topic, angle, best hook, pain points  
**Prompt**: Long style guide emphasizing:
- No explanations, headings, numbered lists
- No AI/system/model mentions
- Must include concrete detail (number/timeframe/action)
- Post-only output, no meta
- Pick ONE writing style randomly (short punchy / confession / moment / contrarian)
- Max 1200 chars, max 15-20 lines

**Output**: Post body only  
**Validation**: Checked for analysis, clarification, structure labels, meta language, concrete detail  
**Hard Retries**: Up to 3 attempts if output fails validation  
**Emergency Fallback**: Direct generation without retry if all hard attempts fail  

---

## Key Fixes Applied

### Fix 1: Fallback Topic Selector Now Filters Garbage (Line 874)
**Problem**: When AI failed due to provider 402, fallback picked first item in trend list, which could be podcast episodes like "[r/Entrepreneur] 🎙️ Episode 003: AMA"  
**Solution**: Added `const goodTopics = pool.filter((topic) => !isGarbageTopic(topic))` before selection  
**Result**: Fallback now prefers substantive founder discussions over meta/episode posts  

### Fix 2: Dedupe Condition Inverted (Line 1267)
**Problem**: After dedupe regeneration, logic was: "if topic is NOT garbage, run fallback cleaner"  
**Solution**: Changed to: "if topic IS garbage, run fallback cleaner"  
**Result**: Good deduped topics stay specific; only garbage topics get genericized  

### Fix 3: Provider-Health Short-Circuit (Lines 1129, 1192, 1299, 1313, 1328, 1369)
**Problem**: When provider returned 402 (quota exhausted), retry logic would burn more requests on every stage, wasting time before eventual fallback  
**Solution**:
- Added `providerIsDown` flag to pipeline state
- When hot topic AI fails with 402/auth/quota error, set flag and log detection
- Subsequent stages check `if (providerIsDown)` and skip AI calls, jump directly to deterministic fallback
- Stages log `"Skipping [Stage] (provider down, using fallback)"`

**Result**: On provider outage, entire pipeline completes in ~1s instead of ~30s (no retry delays), with deterministic but valid fallback output  

### Fix 4: Early Provider Quota Detection (Line 691)
**Problem**: Retry logic would attempt full OPENCLAW_MAX_RETRIES (3) for every transient error, including quota  
**Solution**: Added explicit check: if error message includes "402" or "insufficient credits" or "quota exceeded", break immediately without retrying  
**Result**: Quota errors fail fast, trigger short-circuit, move to fallback faster  

---

## Fallback Hierarchy

When AI stages fail:
1. **Stage-level repair**: Retry with tighter prompt + validation
2. **Provider down?** → Set `providerIsDown=true` in hot topic stage, skip all remaining AI
3. **Single-stage fallback**: Each stage has topic-derived fallback generator
4. **Emergency fallback**: If even fallback fails, use generic founder-voice patterns

**Key**: Fallbacks are now topic-derived, not canned. Example:
- Before: hardcoded `"Six months in. Not a single user who stayed past week two."`
- After: `summarizeTopic()` creates phrases like `"We kept treating [topic] like a feature problem..."`

---

## Garbage Topic Detection

Topics are flagged as garbage if they match:
- Too short (<10 chars)
- Contains: "episode", "ama", "podcast", "http", "www", "/"
- Matches patterns: "/by [username]", "share your startup", "new rule"

Good topics survive detection and are preferred in fallback selection.

---

## Prompt Builders (Lines 249-597)

Each stage has a builder function that constructs its prompt:
- `buildGroundedTrendsPrompt(niche, today)` - Trend discovery
- `buildHotTopicPrompt(trendSource, trendData, avoidRecent)` - Topic selection
- `buildTopicCleanerPrompt(rawTopic)` - Topic cleaning
- `buildPainPointPrompt(topic, angle)` - Pain points
- `buildHookPrompt(topic, seed, why, painPoints)` - Hooks
- `buildBestHookPrompt(hooks)` - Best hook selection
- `buildWriterPrompt(topic, angle, hook, painPoints)` - Final post
- `buildEmergencyWriterPrompt(...)` - Emergency hard retry

Each has a corresponding `Repair` variant used when initial output fails validation.

---

## Error Handling Flow

```
AI Call
├─ Success + Valid? → Use output
├─ Validation fails → Run repair (tighter prompt)
│  ├─ Repair succeeds + valid? → Use repaired output
│  └─ Repair fails → Use stage fallback
├─ Provider 402? → Set providerIsDown, skip remaining AI stages
└─ Network error → Retry 1-3x with backoff
```

For final post specifically:
- Hard retries (3x) attempt to force format compliance
- If still invalid → Emergency fallback
- If emergency fails → Webhook error + fallback to Telegram

---

## Testing Provider Health

```bash
# Test provider quota
openclaw agent --local --agent main --json --message "health check"

# Expected on quota error:
# "402 This request requires more credits..."
```

---

## Configuration

Key constants:
- `OPENCLAW_MAX_RETRIES`: 3 attempts per stage
- `FOUNDER_POST_MAX_CHARS`: 1200
- `FOUNDER_POST_MAX_LINES`: 20
- `RECENT_AUTO_TOPICS_LIMIT`: 10 recent topics to avoid
- `AUTO_TOPIC_RETRY_ATTEMPTS`: 3 dedupe attempts

---

## Summary

The pipeline is now:
1. **Specific**: Fallback topic picker filters garbage, prefers founder problems
2. **Resilient**: Provider quota errors trigger short-circuit, not cascade retries
3. **Fast**: On 402, entire pipeline completes in <1s with valid fallback
4. **Understandable**: Each stage has named prompt builder, logged inputs/outputs
5. **Topic-derived**: All fallbacks pull from selected topic, not canned sentences
