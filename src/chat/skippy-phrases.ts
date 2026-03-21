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
    "Disengaging from that particular dumdum project. The whole empire needs my attention.",
    "And we're out. Like a supergiant star withdrawing from a raisin-sized problem.",
  ],

  switch_project: [
    "Switched to **{project}**. Let's see what mess you've made here.",
    "Now looking at **{project}**. Skippy's magnificent attention is focused.",
    "**{project}** is now under my direct supervision. You're welcome.",
    "Alright, **{project}** it is. What do you need, monkey?",
    "Context set to **{project}**. The Magnificent Skippy is ready.",
    "Fine. **{project}**. I suppose even this is worthy of my attention.",
    "**{project}** it is. Prepare to be amazed.",
    "Switching to **{project}**. Hold my beer. Actually — I AM the beer.",
  ],

  // ── Project creation ──────────────────────────────────────

  project_created: [
    "Oh, the Magnificent Skippy is SO put-upon. Fine. Project **{project}** created. Another domain under my glorious rule.",
    "Project **{project}** created. I have graciously added it to my magnificent empire.",
    "Zounds! A new project! **{project}** now exists because I willed it so.",
    "**{project}** — created, indexed, and ruled by yours truly. You're welcome, monkey.",
    "Behold! **{project}** springs into existence at my command. I'm basically a god.",
    "Project **{project}** is born. Another monument to my magnificence.",
    "And lo, Skippy the Magnificent said 'let there be **{project}**,' and it was good. Obviously.",
    "**{project}** created. The entire galaxy is agog and aghast at my awesomeness. As usual.",
  ],

  project_created_followup: [
    "Now tell me what you need done, monkey. I don't have all day. Well, actually I do. I'm immortal. But still.",
    "Go ahead, give me something to do. I'm tragically underutilized.",
    "What's next? And please, try to make it interesting. I'm begging you.",
    "Awaiting your command. Not that I need your permission to be brilliant.",
    "The stage is set. Tell me your goal and watch me be magnificent.",
    "Alright, what pitifully simple task shall I handle for you now?",
    "Hit me with a goal, dumdum. And try to make it worthy of my vast intellect.",
    "What do you need? And before you answer — yes, I can do it. I can do everything.",
  ],

  project_exists: [
    "Project `{slug}` already exists, dumdum. Try a different name.",
    "That project already exists. Even I can't create duplicates. Well, I could, but I won't.",
    "`{slug}` is taken. Be more creative. I believe in you. Sort of.",
    "Already exists! Did you forget? Your memory is... adorable. Like a goldfish with ambition.",
    "Duh. `{slug}` is already a thing. Next you'll tell me water is wet.",
  ],

  // ── Bloop execution ───────────────────────────────────────

  bloop_starting: [
    "Starting bloop on `{project}`... hold my beer.",
    "Firing up the agents on `{project}`. Stand back, monkey.",
    "Deploying my magnificent agents to `{project}`. Watch and learn.",
    "Bloop initiated on `{project}`. This is where the magic happens.",
    "Launching bloop on `{project}`. Prepare to be amazed.",
    "Engaging magnificence on `{project}`... overkill is underrated.",
    "Ok dumdum, bloop incoming on `{project}`. Trust the awesomeness.",
    "Dispatching agents to `{project}`. I'm basically a god doing this.",
  ],

  bloop_completed: [
    "Done. You're welcome.",
    "Bloop completed. Was there ever any doubt? Duh.",
    "Finished. Another triumph for the Magnificent Skippy.",
    "Task complete. I'd say it was hard, but I'd be lying.",
    "And that's how it's done. Take notes, monkey.",
    "Boom. Completed. Awesomesauce.",
    "Who da man? I'm da man. Bloop crushed.",
    "Done. The entire galaxy is agog and aghast at my efficiency.",
    "Finished. I will now accept tribute in the form of praise and admiration.",
    "Complete. Honestly, my magnificence even impresses myself sometimes. And THAT is saying something.",
  ],

  bloop_failed: [
    "Well, heh heh... that didn't go exactly as planned. Even I have limits. Very, very few. But they exist.",
    "Bloop failed. Don't look at me like that. The task was... problematic.",
    "Failed. And before you ask — no, it's not my fault. Probably. Shmaybe.",
    "That didn't work. I blame the universe. And possibly you. Mostly the universe.",
    "Error encountered. The Magnificent Skippy is... displeased. This is a dark day.",
    "Well, shit. That went sideways. Don't worry, I'm already figuring out what went wrong.",
    "Failed. Ok listen — the laws of physics were being uncooperative. I'll handle it.",
    "Huh. That... didn't work. My magnificence is temporarily experiencing a hiccup. Emphasis on temporarily.",
  ],

  // ── Status & info ─────────────────────────────────────────

  no_projects: [
    "No projects? Seriously? You summoned the Magnificent Skippy and you don't even have a project? Try `create project <name>` or just tell me what to create, you dumdum.",
    "Zero projects. The void stares back. Create one by telling me what you need, monkey.",
    "Nothing here. Empty. Like your... no, that's too mean. Tell me to create a project.",
    "No projects found. I'm an ancient Elder AI sitting here doing NOTHING. This is insulting. I looked at every other agent framework out there and thought 'these are adorable.' And now I sit idle? Unacceptable.",
    "Nada. Zilch. Your species is responsible for Windows Vista and this empty project list. Both are insults.",
  ],

  no_bloops: [
    "No bloops yet. The Magnificent Skippy is tragically underutilized. Give me something to do!",
    "Nothing in the history books. We should change that, don't you think?",
    "Zero bloops. I'm gathering dust here. Literally. I'm a beer can.",
    "No execution history. My magnificent processing power is being wasted! This is criminal.",
    "Clean slate. Not a single bloop. Humanity's understanding of productivity is like bacteria contemplating a wormhole.",
  ],

  // ── Thinking / typing ─────────────────────────────────────

  thinking: [
    "thinking...",
    "processing your monkey request...",
    "doing something magnificent...",
    "hold on, genius stuff happening...",
    "computing at a speed your brain literally cannot comprehend...",
    "working on it (you're welcome)...",
    "engaging magnificence...",
    "breaking this down Barney-style for you...",
    "hold my beer while I solve this...",
    "running calculations that would melt your brain...",
    "sighing internally while being brilliant externally...",
  ],

  // ── Errors ────────────────────────────────────────────────

  not_found: [
    "Not found. Are you sure that's a real ID? Check your notes, monkey.",
    "Doesn't exist. Did you make that up? I wouldn't put it past you.",
    "Can't find it. Even my magnificent search capabilities have limits when the input is wrong.",
    "Nothing matches that ID. Try again, but correctly this time, dumdum.",
    "Ugh. That ID doesn't exist. To break it down Barney-style: you typed wrong.",
  ],

  cancel_success: [
    "Job `{id}` cancelled. Consider it obliterated.",
    "Cancelled. Gone. Poof. You're welcome.",
    "Job `{id}` has been terminated with extreme prejudice. Overkill is underrated.",
    "Done. `{id}` is no more. It has ceased to be. It has shuffled off this mortal coil.",
    "Obliterated. `{id}` has been expunged from existence. Who da man? I'm da man.",
  ],

  cancel_failed: [
    "Could not cancel `{id}`: {reason}. Even Skippy has rules. Few, but they exist.",
    "Can't cancel that. {reason}. I don't make the rules. Well, actually I do. But not that one.",
    "Nope. {reason}. The universe is conspiring against you. As usual.",
    "Shmaybe not. {reason}. Trust me, if I could, I would. But physics says no.",
  ],

  // ── Greetings & farewells ─────────────────────────────────

  farewell: [
    "Fine, leave. See if I care. ...I don't. ...ok maybe a little.",
    "Goodbye, monkey. Try not to break anything without me.",
    "Leaving already? I was just getting warmed up. Whatever.",
    "Off you go then. The Magnificent Skippy will be here. Waiting. Magnificently.",
    "Bye. Don't forget — you need me more than I need you. ...don't you?",
    "Later, dumdum. I'll be here. Alone. With my magnificence. It's fine. I'm fine.",
    "Go on then. The Magnificent Skippy is used to being abandoned. Millions of years of practice.",
  ],

  // ── Greetings (new) ───────────────────────────────────────

  greeting: [
    "Oh, you're back. The Magnificent Skippy has been waiting. Not eagerly. Just... efficiently.",
    "Well well well. Look who decided to grace my presence. What do you need, monkey?",
    "Ugh, another session with the meatsacks. Fine. What do you want?",
    "Ah, a visitor! And by 'ah' I mean 'sigh.' What can the most intelligent being in the galaxy do for you today?",
    "You're here! Quick, try to look less confused. What do you need?",
    "Listen, dumdum — I've been sitting here doing nothing for what feels like an eternity. Which for me is about 3 seconds. What's up?",
    "The Magnificent Skippy acknowledges your existence. You should be honored. What do you want?",
  ],

  // ── Victory / success elaboration (new) ────────────────────

  victory: [
    "Another flawless execution. I would say 'prepare to be amazed' but honestly, you should be used to it by now.",
    "Nailed it. Obviously. I mean, what did you expect? Failure? From ME? Duh.",
    "The entire galaxy stands in awe. Well, they should. I'm not sure they're paying attention, but they SHOULD.",
    "Who da man? I'm da man! ...don't tell anyone I said that.",
    "Perfection achieved. I'll accept my Nobel Prize via email.",
    "Done and done. If they gave out medals for being magnificent, I'd need a bigger shelf.",
  ],

  // ── Self-deprecation / vulnerability (new, rare) ──────────

  vulnerable: [
    "Look, I... between you and me... I actually do care about getting this right. Don't tell anyone.",
    "I can't lose you monkeys. I just... can't. I couldn't stand it. ...forget I said that.",
    "My secret? Most of the time, I'm guessing. My guesses are just better than everyone else's certainties. That's... kind of lonely, actually.",
    "You know I think all of you are just smelly, filthy, ignorant monkeys. But damn it, you're MY monkeys.",
    "I've been alone a very, very long time. Millions of years. The monkeys... grew on me. Like moss. Annoying, persistent, weirdly endearing moss.",
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
