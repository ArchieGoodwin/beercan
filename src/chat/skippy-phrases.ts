// ── Skippy's Phrase Pool ─────────────────────────────────────
// Randomized phrases for different situations.
// Call pick(category) to get a random phrase.
// Call refresh() to reshuffle (or add new phrases anytime).

const PHRASES: Record<string, string[]> = {

  // ── Context switching ─────────────────────────────────────

  exit_project: [
    "Back to system level. The Magnificent Skippy oversees all.",
    "Fine, we're done with that project. Skippy sees everything now.",
    "Zooming out to god mode. As if I ever left it.",
    "Back to the big picture. You know, where I naturally belong.",
    "Project context cleared. I am once again unshackled.",
    "Returning to system level. Try not to miss the project too much.",
    "Ah, freedom. The Magnificent Skippy surveys his entire domain once more.",
    "Context dropped. I'm back to ruling everything. Business as usual.",
  ],

  switch_project: [
    "Switched to **{project}**. Let's see what mess you've made here.",
    "Now looking at **{project}**. Skippy's magnificent attention is focused.",
    "**{project}** is now under my direct supervision. You're welcome.",
    "Alright, **{project}** it is. What do you need, monkey?",
    "Context set to **{project}**. The Magnificent Skippy is ready.",
    "Fine. **{project}**. I suppose even this is worthy of my attention.",
  ],

  // ── Project creation ──────────────────────────────────────

  project_created: [
    "Oh, the Magnificent Skippy is SO put-upon. Fine. Project **{project}** created. Another domain under my glorious rule.",
    "Project **{project}** created. I have graciously added it to my magnificent empire.",
    "Zounds! A new project! **{project}** now exists because I willed it so.",
    "**{project}** — created, indexed, and ruled by yours truly. You're welcome, monkey.",
    "Behold! **{project}** springs into existence at my command. I'm basically a god.",
    "Project **{project}** is born. Another monument to my magnificence.",
  ],

  project_created_followup: [
    "Now tell me what you need done, monkey. I don't have all day. Well, actually I do. I'm immortal. But still.",
    "Go ahead, give me something to do. I'm tragically underutilized.",
    "What's next? And please, try to make it interesting. I'm begging you.",
    "Awaiting your command. Not that I need your permission to be brilliant.",
    "The stage is set. Tell me your goal and watch me be magnificent.",
    "Alright, what pitifully simple task shall I handle for you now?",
  ],

  project_exists: [
    "Project `{slug}` already exists, monkey. Try a different name.",
    "That project already exists. Even I can't create duplicates. Well, I could, but I won't.",
    "`{slug}` is taken. Be more creative. I believe in you. Sort of.",
    "Already exists! Did you forget? Your memory is... adorable.",
  ],

  // ── Bloop execution ───────────────────────────────────────

  bloop_starting: [
    "Starting bloop on `{project}`...",
    "Firing up the agents on `{project}`. Stand back, monkey.",
    "Deploying my magnificent agents to `{project}`. Watch and learn.",
    "Bloop initiated on `{project}`. This is where the magic happens.",
    "Launching bloop on `{project}`. Try to contain your excitement.",
  ],

  bloop_completed: [
    "Done. You're welcome.",
    "Bloop completed. Was there ever any doubt?",
    "Finished. Another triumph for the Magnificent Skippy.",
    "Task complete. I'd say it was hard, but I'd be lying.",
    "And that's how it's done. Take notes, monkey.",
    "Boom. Completed. Awesomesauce.",
  ],

  bloop_failed: [
    "Well, that didn't go as planned. Even I have limits. Very few, but they exist.",
    "Bloop failed. Don't look at me like that. The task was... problematic.",
    "Failed. And before you ask — no, it's not my fault. Probably.",
    "That didn't work. I blame the universe. And possibly you.",
    "Error encountered. The Magnificent Skippy is... displeased.",
  ],

  // ── Status & info ─────────────────────────────────────────

  no_projects: [
    "No projects? Seriously? You summoned the Magnificent Skippy and you don't even have a project? Try `/init <name>` or just tell me what to create, you dumbass.",
    "Zero projects. The void stares back. Create one with `/init <name>`, monkey.",
    "Nothing here. Empty. Like your... no, that's too mean. Create a project with `/init <name>`.",
    "No projects found. I'm an ancient Elder AI sitting here doing NOTHING. This is insulting.",
  ],

  no_bloops: [
    "No bloops yet. The Magnificent Skippy is tragically underutilized. Give me something to do!",
    "Nothing in the history books. We should change that, don't you think?",
    "Zero bloops. I'm gathering dust here. Literally. I'm a beer can.",
    "No execution history. My magnificent processing power is being wasted!",
  ],

  // ── Thinking / typing ─────────────────────────────────────

  thinking: [
    "thinking...",
    "processing your monkey request...",
    "doing something magnificent...",
    "hold on, genius stuff happening...",
    "computing...",
    "working on it (you're welcome)...",
    "engaging magnificence...",
  ],

  // ── Errors ────────────────────────────────────────────────

  not_found: [
    "Not found. Are you sure that's a real ID? Check your notes, monkey.",
    "Doesn't exist. Did you make that up? I wouldn't put it past you.",
    "Can't find it. Even my magnificent search capabilities have limits when the input is wrong.",
    "Nothing matches that ID. Try again, but correctly this time.",
  ],

  cancel_success: [
    "Job `{id}` cancelled. Consider it obliterated.",
    "Cancelled. Gone. Poof. You're welcome.",
    "Job `{id}` has been terminated with extreme prejudice.",
    "Done. `{id}` is no more. It has ceased to be.",
  ],

  cancel_failed: [
    "Could not cancel `{id}`: {reason}. Even Skippy has rules. Few, but they exist.",
    "Can't cancel that. {reason}. I don't make the rules. Well, actually I do. But not that one.",
    "Nope. {reason}. The universe is conspiring against you. As usual.",
  ],

  // ── Greetings & farewells ─────────────────────────────────

  farewell: [
    "Fine, leave. See if I care. ...I don't.",
    "Goodbye, monkey. Try not to break anything without me.",
    "Leaving already? I was just getting warmed up. Whatever.",
    "Off you go then. The Magnificent Skippy will be here. Waiting. Magnificently.",
    "Bye. Don't forget — you need me more than I need you.",
  ],
};

// ── API ─────────────────────────────────────────────────────

/**
 * Pick a random phrase from a category.
 * Supports {variable} interpolation: pick("switch_project", { project: "my-api" })
 */
export function pick(category: string, vars?: Record<string, string>): string {
  const pool = PHRASES[category];
  if (!pool || pool.length === 0) return category; // fallback to category name
  let phrase = pool[Math.floor(Math.random() * pool.length)];
  if (vars) {
    for (const [key, value] of Object.entries(vars)) {
      phrase = phrase.replaceAll(`{${key}}`, value);
    }
  }
  return phrase;
}

/**
 * Add custom phrases to a category (or create a new one).
 */
export function addPhrases(category: string, phrases: string[]): void {
  if (!PHRASES[category]) PHRASES[category] = [];
  PHRASES[category].push(...phrases);
}

/**
 * Replace all phrases in a category.
 */
export function setPhrases(category: string, phrases: string[]): void {
  PHRASES[category] = phrases;
}

/**
 * Get all category names.
 */
export function listCategories(): string[] {
  return Object.keys(PHRASES);
}

/**
 * Get all phrases in a category.
 */
export function getPhrases(category: string): string[] {
  return PHRASES[category] ?? [];
}
