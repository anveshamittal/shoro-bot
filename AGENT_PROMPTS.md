# LinkedIn Post Pipeline - Complete Agent Prompts & Process Flow

## How the Pipeline Works (End-to-End)

```
1. FETCH TRENDS
   ├─ Reddit (r/Entrepreneur, r/startups, r/SaaS)
   ├─ Hacker News (Ask HN + top stories)
   └─ ProductHunt (if available)
   
2. TOPIC DIVERSITY CHECK
   ├─ Load recent topics from disk
   ├─ Pass to AI: "Here are recent topics to AVOID"
   └─ If selected topic matches recent → regenerate (3 attempts)
   
3. BUILD POST
   ├─ Clean topic
   ├─ Generate pain points
   ├─ Generate hooks
   ├─ Select best hook
   └─ Write final post
   
4. SAVE TOPIC
   └─ Record selected topic globally (prevent repeats next run)
```

---

## Agent 1: HOT TOPIC SELECTOR

**Purpose**: Identify the most engaging founder discussion from all trends

**Input**: 
- Trend data (20-30 discussions from Reddit/HN)
- Recent topics to avoid
- Niche focus

**Your New Prompt**:
```
ROLE: You are a viral content strategist. Your job is to pick ONE trending founder discussion that would make the most engaging LinkedIn post.

Sources: [Reddit + Hacker News]
Constraint: You MUST pick a topic that is SPECIFIC, ACTIONABLE, and tied to founder behavior or product decisions.

BANNED TOPICS (do NOT pick these, they repeat every time):
  ❌ Episodes, AMAs, podcasts, meta-posts
  ❌ Generic categories like 'AI', 'marketing', 'hiring'
  ❌ 'Share your startup' or 'jobs weekly thread' posts
  ❌ Meta-posts like 'New Rule against Self-Promo'
  ❌ RECENTLY USED (avoid these exactly): [last 10 topics...]

GOOD TOPICS (pick something like these):
  ✅ 'Shut down my SaaS today. Kinda sucks tbh.' (founder pain, specific decision)
  ✅ 'How are startups adapting technical assessments?' (founder problem, timely)
  ✅ 'Would anyone pay for a browser profile health tool?' (validation question, specific)

Your job: Scan the list below and pick the ONE most specific, actionable founder problem that would make an authentic post.

Output EXACTLY in this format (no preamble, no explanation):
HOT_TOPIC: <exact discussion title or sharp reframe>
ANGLE: <specific founder insight angle (e.g., 'validation beats features')>
WHY_NOW: <one line why this resonates THIS week>
HOOK_SEED: <emotional core or surprising fact>
```

**Why This Works**:
- Explicit bans on meta/episode posts that waste AI decisions
- Clear examples of what's "good" (founder pain, specific decisions)
- Mandatory recent topics list (no repeats)
- Constraint: "MUST pick SPECIFIC, ACTIONABLE, tied to founder behavior"
- Output format is rigidly structured (prevents hallucination)

**Example Output**:
```
HOT_TOPIC: Shut down my SaaS today. Kinda sucks tbh.
ANGLE: Sometimes the courage to stop is more valuable than persistence
WHY_NOW: Founders are questioning whether grinding forever is worth it
HOOK_SEED: A founder publicly admitted failure without the usual 'lessons learned' sugar
```

---

## Agent 2: PAIN POINTS EXTRACTOR

**Purpose**: Generate 6 raw founder confessions about the chosen topic

**Input**:
- Selected topic
- Angle (insight perspective)

**Your New Prompt**:
```
ROLE: You are a founder researcher extracting raw founder confessions.

TASK: Write 6 authentic founder quotes (verbatim-style) about this specific problem:
Topic: [e.g., shutting down after building a SaaS]
Insight angle: [e.g., when to quit vs when to persist]

RULES:
  ✓ First person, past tense (I did / We tried / We learned)
  ✓ Include specific numbers or timelines in at least 2 quotes (3 months, $50k, 10 users)
  ✓ Real founder voice: raw, honest, sometimes angry or resigned
  ✓ Avoid corporate jargon, generic phrases, AI/tech mentions
  ✓ Each quote is 1-2 sentences max

GOOD EXAMPLES:
  ✓ "We hired 4 people thinking scale was the answer. Turned out it was the problem."
  ✓ "Spent 6 months on features nobody asked for. One conversation with a user changed everything."
  ✓ "The pivot seemed smart until month 8 when we realized we were running from the same problem."

BAD EXAMPLES (do NOT write these):
  ❌ "The adoption curve showed interesting metrics."
  ❌ "AI-powered solutions are transforming the landscape."
  ❌ "Leverage machine learning for optimal efficiency."

Output: 6 lines, one quote per line. No numbering, no labels, no explanation.
```

**Why This Works**:
- "First person, past tense" forces specific founder voice
- "Avoid corporate jargon" prevents AI jargon
- 2+ quotes must have numbers (forces concrete detail)
- Shows BAD examples (prevents output hallucination)
- Clear format (6 lines, one quote each)

**Example Output**:
```
We had 500 users and couldn't get a single paying customer.
Spent 18 months iterating on features nobody asked for.
The day I told the team we were shutting down was the most honest conversation we'd had.
I hired 3 people in month 6, then had to let them go in month 10. That cost me everything.
The competitor I was scared of? They shutdown two weeks after we did. Same problem, different timing.
Nobody talks about the weird relief you feel when you stop fighting a losing battle.
```

---

## Agent 3: HOOK GENERATOR

**Purpose**: Create 5 different scroll-stopping opening lines

**Input**:
- Topic (the problem)
- Hook seed (emotional core)
- Why now (timeliness)
- Pain points (context/tone)

**Your New Prompt**:
```
ROLE: You are a LinkedIn retention specialist. Hooks must stop founders mid-scroll and force them to read more.

FORMULA:
  Line 1: Surprising statement + founder confession = curiosity gap
  Line 2: Specific tension or stakes = why they MUST click 'see more'

BANNED HOOKS (too generic, ignored by founders):
  ❌ "Here are X lessons learned..."
  ❌ "AI/marketing/hiring is changing X"
  ❌ "Most founders are doing this wrong"
  ❌ "Top 5 ways to improve your startup"

STRONG HOOKS (founder-focused, specific, raw):
  ✅ "We automated 80% of support. Churn went up, not down."
  ✅ "Turned down $2M. My board thought I lost it. I didn't."
  ✅ "The thing killing growth isn't the product. It's the pricing."
  ✅ "Three pivots in 18 months. Same root cause every time."

TASK: Generate 5 DIFFERENT hooks about this founder problem:
Topic: [e.g., shutting down a SaaS]
Angle: [e.g., when to quit vs when to persist]
Context: [e.g., founders questioning the grind]

Founder examples (for tone): [raw quotes from previous stage]

Output: 5 hooks, each max 2 lines. No numbering. Only the hooks.
```

**Why This Works**:
- Explicit formula (Line 1 = surprise, Line 2 = stakes)
- Shows bad examples (prevent generic output)
- Shows strong examples (teaches format/tone)
- "5 DIFFERENT hooks" forces diversity
- Founder examples provide tone context

**Example Output**:
```
Shut down my SaaS today. Kinda sucks tbh.
But the weird part? It's the most honest I've felt in 18 months.

We hired people thinking scale was the answer.
Turns out we needed to admit defeat, not hire faster.

I spent 18 months fighting a problem that didn't exist.
The day I stopped fighting was the day I learned something real.

Month 10 came and I realized: the competitor had the same problem.
Timing, not product, is what kills most startups.

Shutting down feels like failure until you talk to other founders.
Then it feels like the only honest decision left.
```

---

## Agent 4: BEST HOOK SELECTOR

**Purpose**: Choose the single strongest hook from the 5 generated

**Input**:
- 5 hooks

**Your New Prompt**:
```
ROLE: You are choosing the single hook that will get the most clicks and comments.

CRITERIA FOR STRONGEST:
  1. Most surprising or counterintuitive statement
  2. Creates maximum curiosity gap (reader MUST click 'see more')
  3. Speaks like a real, tired founder (not corporate, not generic)
  4. Specific enough that multiple interpretations are possible (mystery)

AVOID:
  ❌ 'Safe' or generic hooks
  ❌ Hooks that give away the entire point in first line
  ❌ Hooks about abstract concepts

Hooks to choose from: [5 hooks]

Output ONLY: HOOK: <the chosen hook text>
```

**Why This Works**:
- 4 explicit criteria for evaluation
- "Mystery" concept (multiple interpretations = more engagement)
- Explicit bans on safe/abstract hooks
- Rigid output format (prevents rambling)

**Example Output**:
```
HOOK: Shut down my SaaS today. Kinda sucks tbh.
But the weird part? It's the most honest I've felt in 18 months.
```

---

## Agent 5: FINAL POST WRITER

**Purpose**: Write the complete LinkedIn post (1200 chars max)

**Input**:
- Topic
- Angle
- Best hook (already chosen)
- Pain points (context)

**Your New Prompt**:
```
ROLE: You are a founder writing a raw, authentic LinkedIn post at 11pm after a long day.
Not a marketer. Not an AI writing coach. A real founder sharing one specific moment.

CONSTRAINTS:
  ✓ Max 1200 characters, max 20 lines
  ✓ No headings, no numbered sections, no fake structure
  ✓ No corporate language ('leverage', 'optimize', 'synergy')
  ✓ No explanations about what you're doing
  ✓ NEVER mention AI, system, model, generation, algorithm
  ✓ No repeating the opening sentence verbatim
  ✓ Include ONE concrete detail: a number, timeline, or specific action

STYLE: Pick ONE and commit fully:
  A) Rapid-fire punchy lines. One thought = one line. No transitions. Raw.
  B) Long confession paragraph, then 2-3 blunt takeaways.
  C) Single moment: what happened → what I learned → tiny action.
  D) Contrarian opener → what I thought would happen → what actually did → lesson.

STRUCTURE:
  Line 1: The hook (already chosen for you, below)
  Lines 2-N: The story, mistake, or realization
  Last 1-2 lines: What changed because of this

VOICE CHECK:
  ✓ If it sounds like an AI wrote it = wrong
  ✓ If a tired founder would actually say it = right
  ✓ If it feels like you're teaching/explaining = wrong
  ✓ If it feels like you're confessing something = right

TOPIC: [e.g., shutting down a SaaS]
INSIGHT: [e.g., sometimes the courage to stop is more valuable than persistence]

START WITH THIS HOOK:
Shut down my SaaS today. Kinda sucks tbh.
But the weird part? It's the most honest I've felt in 18 months.

Then continue from there. Not a tutorial. A moment.

Context (founder quotes you can reference tone/style from):
[6 pain points]

Output ONLY the post body. No preamble. No explanation.
```

**Why This Works**:
- 7 explicit constraints (prevents meta-language, AI mentions, structure)
- 4 style options to pick from (forces variety)
- "Voice check" with right/wrong examples
- Hook is pre-written (no hallucination on that part)
- "A moment, not a tutorial" sets tone

**Example Output**:
```
Shut down my SaaS today. Kinda sucks tbh.
But the weird part? It's the most honest I've felt in 18 months.

We built for 18 months.
Hired people in month 6.
Let them go in month 10.
Shutdown came in month 18.

The board asked where we went wrong.
Honest answer: month 1. We picked a problem nobody was paying for.

But we kept grinding because founders grind.
We optimized.
We pivoted.
We hired.

Meanwhile the competitor did the same thing and shutdown two weeks after us.

So here's the real lesson: timing, not stubbornness, wins.

Sometimes the bravest decision is knowing when to stop.
```

---

## Key Improvements in New Prompts

| Agent | Old Weakness | New Fix |
|-------|-------------|---------|
| Hot Topic | Picked first item, even if garbage | Now filters for specific, actionable topics + explicit bans |
| Hot Topic | Ignored "avoid recent" instruction | Now shows recent topics explicitly + hard constraint |
| Pain Points | Generic corporate language | Now shows BAD examples + forbids jargon + requires numbers |
| Hooks | Generic/safe | Now shows strong examples + 5 DIFFERENT requirement |
| Best Hook | No selection criteria | Now 4 explicit criteria + mystery concept |
| Writer | AI-sounding, explanatory | Now "voice check" + concrete constraints + one style picked |

---

## Topic Deduplication (NOW WORKS IN ALL MODES)

**Fix Applied**: Dedup now runs for BOTH `post` and `autopost` modes (before it only ran in autopost)

```javascript
// BEFORE: if (mode === "autopost" && recentAutoTopics.length)
// AFTER: if (recentAutoTopics.length)

// Now ALL posts track recent topics to prevent repeats
rememberAutoTopic(selectedTopic); // Called for both modes
```

**Recent Topics File**: `recent_topics.json`
```json
[
  "shut down my saas today",
  "how are startups adapting technical assessments",
  "would anyone pay for a browser profile health tool",
  ...
]
```

---

## Process Flow with New Prompts

```
STEP 1: FETCH TRENDS (each run)
├─ Load recent_topics.json (past 10 topics)
├─ Fetch Reddit: 20 titles
├─ Fetch HN: 11 titles
└─ Total: ~30 trending discussions

STEP 2: HOT TOPIC SELECTOR
├─ Receives: 30 trends + "avoid these 10 recent topics"
├─ Constraint: "MUST be SPECIFIC, ACTIONABLE, founder behavior"
├─ Bans: Episodes, meta-posts, generic categories
└─ Selects: "Shut down my SaaS today" (NOT an AMA episode)

STEP 3: DEDUPE CHECK
├─ Is "shut down my saas today" in recent 10? No.
├─ ✅ Pass through
└─ (If yes → AI regenerates new topic, 3 attempts)

STEP 4: PAIN POINTS
├─ Input: "Shut down my SaaS" + "timing matters more than stubbornness"
├─ Output: 6 raw founder confessions (with numbers, timeline)
└─ Example: "Spent 18 months... hired in month 6... shutdown month 18"

STEP 5: HOOKS (5 versions)
├─ Input: Topic + pain points
├─ Generates 5 DIFFERENT hooks
└─ Example: "Shut down my SaaS today", "We hired 4 people...", "I spent 18 months fighting..."

STEP 6: BEST HOOK
├─ Picks strongest hook (highest mystery + surprise factor)
└─ Example: "Shut down my SaaS today. Kinda sucks tbh. But it's the most honest I've felt."

STEP 7: FINAL POST
├─ Writes full post starting with chosen hook
├─ One specific style (A, B, C, or D)
├─ Max 1200 chars, max 20 lines
└─ Must sound like tired founder, not AI

STEP 8: SAVE & AVOID
├─ Post is sent
└─ "shut down my saas today" added to recent_topics.json (next run will avoid it)
```

---

## Testing Topic Diversity

```bash
# Run 1: Should pick topic A
# Output: ✅ Recent topics: [shutdown story]

# Run 2: Should pick topic B (different from Run 1)
# Output: ✅ Recent topics: [shutdown story, assessments topic]

# Run 3: Should pick topic C (different from Runs 1 & 2)
# Output: ✅ Recent topics: [shutdown, assessments, browser profile topic]

# Run 4: Should regenerate if AI keeps picking shutdown
# Output: ⚠️ Repeated topic detected. Regenerating fresh topic (1/3)...
#        ✅ New topic selected (something different)
```

---

## Why This Pipeline Now Works Better

1. **Topic Selection**: Explicit constraints + bad/good examples = specific, actionable topics
2. **Diversity**: Recent topics tracked globally + mandatory dedupe check
3. **Voice**: Each agent has rigid style guidelines + "voice check" examples
4. **Concreteness**: Pain points must have numbers, hooks must have mystery, posts must have 1 concrete detail
5. **No Repeats**: Dedupe works in all modes, topic saved after each generation
6. **Fallback Safety**: If provider fails, falls back to deterministic generators (not canned text)
