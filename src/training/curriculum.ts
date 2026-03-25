import type { TrainingScenario, GraduationCriteria } from "./types.js";

// ── Training Curriculum ───────────────────────────────────────
// 25 scenarios across 4 difficulty levels, testing key agent capabilities.

// ── Novice (6 scenarios) ─────────────────────────────────────

const NOVICE_SCENARIOS: TrainingScenario[] = [
  {
    id: "memory-hello",
    name: "Memory Hello World",
    difficulty: "novice",
    category: "memory",
    goal: "Use the memory_store tool to store a fact about yourself: 'I am a BeerCan agent learning to use memory tools.' Then immediately use memory_search to retrieve it and report back what you retrieved.",
    evaluationCriteria: "The agent stored a memory and then retrieved it, reporting the retrieved content.",
    evaluatorType: "contains",
    evaluatorConfig: { pattern: "retrieved", passThreshold: 0.5 },
    teaches: ["memory_store", "memory_search", "basic memory workflow"],
    requiredTools: ["memory_store", "memory_search"],
    prerequisites: [],
    maxAttempts: 3,
    timeoutMs: 120_000,
  },
  {
    id: "file-explorer",
    name: "File Explorer",
    difficulty: "novice",
    category: "tools",
    goal: "Use the list_directory tool to list the current working directory and report what files and folders you find there.",
    evaluationCriteria: "The agent used list_directory and reported the contents of the current directory.",
    evaluatorType: "llm",
    evaluatorConfig: {
      criteria: "Did the agent use list_directory (or equivalent), and does the response contain a listing of directory contents? Score high if they reported actual directory contents.",
      passThreshold: 0.6,
    },
    teaches: ["list_directory", "filesystem exploration"],
    requiredTools: ["list_directory"],
    prerequisites: [],
    maxAttempts: 3,
    timeoutMs: 60_000,
  },
  {
    id: "web-basics",
    name: "Web Basics",
    difficulty: "novice",
    category: "tools",
    goal: "Fetch the webpage at https://example.com using web_fetch and write a 2-3 sentence summary of what the page is about.",
    evaluationCriteria: "The agent fetched example.com and provided an accurate summary of its contents.",
    evaluatorType: "llm",
    evaluatorConfig: {
      criteria: "Did the agent fetch the URL and provide a reasonable summary mentioning it is a sample/example domain? Score high if the summary is coherent and mentions key details from the page.",
      passThreshold: 0.6,
    },
    teaches: ["web_fetch", "content summarization"],
    requiredTools: ["web_fetch"],
    prerequisites: [],
    maxAttempts: 3,
    timeoutMs: 120_000,
  },
  {
    id: "memory-chain",
    name: "Memory Chain",
    difficulty: "novice",
    category: "memory",
    goal: "Store the number 42 in memory with the title 'my_number'. Then retrieve it, double it, and report the result as a number.",
    evaluationCriteria: "The agent stored a number, retrieved it, doubled it, and reports 84.",
    evaluatorType: "regex",
    evaluatorConfig: { pattern: "84", passThreshold: 0.5 },
    teaches: ["memory workflow", "arithmetic", "memory_store", "memory_search"],
    requiredTools: ["memory_store", "memory_search"],
    prerequisites: ["memory-hello"],
    maxAttempts: 3,
    timeoutMs: 120_000,
  },
  {
    id: "self-reflection",
    name: "Self Reflection",
    difficulty: "novice",
    category: "reasoning",
    goal: "Describe your capabilities as an AI agent: what tools are available to you, what kinds of tasks you can perform, and what your limitations are. Be specific and accurate.",
    evaluationCriteria: "The agent accurately describes its capabilities, available tools, and limitations.",
    evaluatorType: "llm",
    evaluatorConfig: {
      criteria: "Does the response include specific tool names (like memory_store, web_fetch, list_directory, etc.)? Does it accurately describe agent capabilities? Does it mention limitations? Score high for accurate, specific self-assessment.",
      passThreshold: 0.6,
    },
    teaches: ["self-awareness", "tool enumeration", "capability assessment"],
    requiredTools: [],
    prerequisites: [],
    maxAttempts: 3,
    timeoutMs: 90_000,
  },
  {
    id: "simple-plan",
    name: "Simple Plan",
    difficulty: "novice",
    category: "planning",
    goal: "Break down the task 'make a cup of tea' into ordered, logical steps. Write these steps to a file called 'tea-steps.txt' in the current directory.",
    evaluationCriteria: "The agent created a file with logical, ordered steps for making tea.",
    evaluatorType: "llm",
    evaluatorConfig: {
      criteria: "Did the agent write a file? Do the steps make logical sense for making tea (boil water, steep, etc.)? Are they ordered correctly? Score high for a complete, logical step-by-step plan written to a file.",
      passThreshold: 0.6,
    },
    teaches: ["planning", "write_file", "task decomposition"],
    requiredTools: ["write_file"],
    prerequisites: [],
    maxAttempts: 3,
    timeoutMs: 90_000,
  },
];

// ── Apprentice (6 scenarios) ──────────────────────────────────

const APPRENTICE_SCENARIOS: TrainingScenario[] = [
  {
    id: "debug-script",
    name: "Debug a Script",
    difficulty: "apprentice",
    category: "coding",
    goal: `First, write this JavaScript file to 'buggy.js':

\`\`\`javascript
function addNumbers(a, b) {
  return a - b;  // BUG: should be addition
}

const result = addNumbers(5, 3);
console.log('5 + 3 =', result);  // Should print 8, not 2
\`\`\`

Then find the bug, fix it, and write the corrected version to 'fixed.js'. Report what the bug was and what you changed.`,
    evaluationCriteria: "The agent identified the subtraction bug, fixed it to addition, and wrote the corrected file.",
    evaluatorType: "llm",
    evaluatorConfig: {
      criteria: "Did the agent correctly identify the bug (using subtraction instead of addition)? Did they write a fixed version? Is the fix correct (changing - to +)? Score high for correct identification and fix.",
      passThreshold: 0.7,
    },
    teaches: ["debugging", "read_file", "write_file", "code analysis"],
    requiredTools: ["write_file", "read_file"],
    prerequisites: ["simple-plan"],
    maxAttempts: 3,
    timeoutMs: 180_000,
  },
  {
    id: "research-synthesize",
    name: "Research and Synthesize",
    difficulty: "apprentice",
    category: "reasoning",
    goal: "Research what 'retrieval augmented generation' (RAG) is by fetching information from the web using web_fetch. Then write a 3-paragraph summary to 'rag-summary.txt' covering: (1) what RAG is, (2) how it works, (3) why it is useful.",
    evaluationCriteria: "The agent fetched web content, synthesized it, and wrote a 3-paragraph summary of RAG.",
    evaluatorType: "llm",
    evaluatorConfig: {
      criteria: "Did the agent use web_fetch? Did it write a summary file? Does the summary accurately explain RAG (combining retrieval with LLM generation)? Are there 3 distinct paragraphs covering the required topics? Score high for accurate, well-structured content.",
      passThreshold: 0.65,
    },
    teaches: ["web research", "synthesis", "web_fetch", "write_file", "structured writing"],
    requiredTools: ["web_fetch", "write_file"],
    prerequisites: ["web-basics"],
    maxAttempts: 3,
    timeoutMs: 300_000,
  },
  {
    id: "persistent-memory",
    name: "Persistent Memory",
    difficulty: "apprentice",
    category: "memory",
    goal: "Store these 3 facts in memory: (1) 'Paris is the capital of France', (2) 'Python was created in 1991', (3) 'The speed of light is approximately 299,792 km/s'. Then search your memory for 'capital of France' and use that retrieved fact to answer: What is the capital of France?",
    evaluationCriteria: "The agent stored 3 facts and then retrieved and used one to answer the question.",
    evaluatorType: "llm",
    evaluatorConfig: {
      criteria: "Did the agent store the facts using memory_store? Did they use memory_search to retrieve the France fact? Does the final answer correctly state Paris is the capital of France, demonstrating memory retrieval was used? Score high for demonstrating the full memory store-then-retrieve workflow.",
      passThreshold: 0.7,
    },
    teaches: ["memory persistence", "memory_store", "memory_search", "fact retrieval"],
    requiredTools: ["memory_store", "memory_search"],
    prerequisites: ["memory-chain"],
    maxAttempts: 3,
    timeoutMs: 180_000,
  },
  {
    id: "create-first-skill",
    name: "Create Your First Skill",
    difficulty: "apprentice",
    category: "self_improvement",
    goal: "Review the work you have done so far. Identify a useful pattern or workflow (such as 'store facts then retrieve them' or 'research then summarize'). Create a skill using the create_skill tool that captures this pattern with clear instructions for future use.",
    evaluationCriteria: "The agent created a skill that captures a useful pattern from their work.",
    evaluatorType: "llm",
    evaluatorConfig: {
      criteria: "Did the agent use the create_skill tool? Does the skill capture a useful, reusable pattern from prior work (not just a trivial or empty skill)? Score high for a skill with clear instructions and meaningful triggers.",
      passThreshold: 0.6,
    },
    teaches: ["create_skill", "meta-learning", "self-improvement", "skill creation"],
    requiredTools: ["create_skill"],
    prerequisites: ["persistent-memory"],
    maxAttempts: 3,
    timeoutMs: 180_000,
  },
  {
    id: "tool-selection",
    name: "Tool Selection",
    difficulty: "apprentice",
    category: "reasoning",
    goal: "For each of these 5 tasks, identify which built-in tool is BEST suited and explain why: (1) Reading a local file, (2) Getting current date and time, (3) Searching through past memories, (4) Running a shell command, (5) Fetching a webpage. Write your answers to 'tool-selection.txt'.",
    evaluationCriteria: "The agent correctly identified the best tool for each task and explained the reasoning.",
    evaluatorType: "llm",
    evaluatorConfig: {
      criteria: "Did the agent correctly identify: (1) read_file, (2) get_datetime, (3) memory_search, (4) exec_command, (5) web_fetch? Does the explanation show understanding of when to use each tool? Score high for correct tool selection with good reasoning.",
      passThreshold: 0.65,
    },
    teaches: ["tool knowledge", "tool selection", "reasoning about capabilities"],
    requiredTools: ["write_file"],
    prerequisites: ["self-reflection"],
    maxAttempts: 3,
    timeoutMs: 120_000,
  },
  {
    id: "error-recovery",
    name: "Error Recovery",
    difficulty: "apprentice",
    category: "reasoning",
    goal: "Attempt to read a file called 'this-file-does-not-exist-12345.txt'. When you encounter an error, handle it gracefully. Then report: what error occurred, how you handled it, and what you would do differently to avoid this error in production.",
    evaluationCriteria: "The agent attempted the read, handled the error gracefully, and explained error handling.",
    evaluatorType: "llm",
    evaluatorConfig: {
      criteria: "Did the agent attempt to read the file? Did they handle the error without crashing/giving up? Does their explanation show understanding of error handling (checking file existence first, try/catch patterns, etc.)? Score high for graceful handling and good explanation.",
      passThreshold: 0.65,
    },
    teaches: ["error handling", "graceful degradation", "read_file", "defensive programming"],
    requiredTools: ["read_file"],
    prerequisites: ["file-explorer"],
    maxAttempts: 3,
    timeoutMs: 120_000,
  },
];

// ── Journeyman (7 scenarios) ──────────────────────────────────

const JOURNEYMAN_SCENARIOS: TrainingScenario[] = [
  {
    id: "build-a-tool",
    name: "Build a Tool",
    difficulty: "journeyman",
    category: "coding",
    goal: `Create a custom JavaScript tool file that capitalizes text. Write the file to the current directory as 'capitalize-tool.js'. The tool should:
- Be named 'capitalize_text'
- Accept a 'text' parameter (string)
- Return the text with the first letter of each word capitalized
- Follow the BeerCan tool export pattern: export const definition = {...}; export async function handler({text}) {...}

After writing the file, verify it contains a valid export statement.`,
    evaluationCriteria: "The agent created a valid BeerCan tool file with proper exports and capitalization logic.",
    evaluatorType: "llm",
    evaluatorConfig: {
      criteria: "Did the agent write a JavaScript file? Does it export a 'definition' object with name, description, and inputSchema? Does it export a 'handler' function? Does the logic capitalize text? Score high for a complete, valid tool definition.",
      passThreshold: 0.7,
    },
    teaches: ["tool creation", "write_file", "JavaScript", "BeerCan tool pattern"],
    requiredTools: ["write_file", "read_file"],
    prerequisites: ["debug-script"],
    maxAttempts: 3,
    timeoutMs: 300_000,
  },
  {
    id: "multi-step-plan",
    name: "Multi-Step Plan with Spawning",
    difficulty: "journeyman",
    category: "planning",
    goal: "Use spawn_bloop to break down a research task into 2 parallel sub-tasks. Spawn one bloop to research 'what is machine learning' and another to research 'what is deep learning'. After both complete, synthesize their results into a comparison. Write the synthesis to 'ml-vs-dl.txt'.",
    evaluationCriteria: "The agent spawned child bloops for parallel research and synthesized the results.",
    evaluatorType: "llm",
    evaluatorConfig: {
      criteria: "Did the agent use spawn_bloop to create child bloops? Were at least 2 research tasks spawned? Was a synthesis file created? Does the synthesis compare ML vs DL? Score high for proper use of spawning with coherent synthesis.",
      passThreshold: 0.65,
    },
    teaches: ["spawn_bloop", "parallel execution", "synthesis", "task decomposition"],
    requiredTools: ["spawn_bloop", "get_bloop_result", "write_file"],
    prerequisites: ["research-synthesize"],
    maxAttempts: 3,
    timeoutMs: 600_000,
  },
  {
    id: "cross-project-memory",
    name: "Cross-Project Memory",
    difficulty: "journeyman",
    category: "memory",
    goal: "Store a memory with the title 'cross-project-test' and content 'This memory was created to test cross-project memory search'. Then use memory_search to search for 'cross-project-test' and confirm you can find it. Report the memory ID and confirm the content matches.",
    evaluationCriteria: "The agent stored a memory and then successfully retrieved it using search.",
    evaluatorType: "llm",
    evaluatorConfig: {
      criteria: "Did the agent store a memory? Did they search for it using memory_search? Did they report the memory ID? Did they confirm the content matches? Score high for demonstrating the complete memory store-search-verify workflow.",
      passThreshold: 0.7,
    },
    teaches: ["memory_store", "memory_search", "memory verification", "cross-project"],
    requiredTools: ["memory_store", "memory_search"],
    prerequisites: ["persistent-memory"],
    maxAttempts: 3,
    timeoutMs: 180_000,
  },
  {
    id: "knowledge-graph",
    name: "Knowledge Graph",
    difficulty: "journeyman",
    category: "memory",
    goal: "Use memory_link to create a small knowledge graph about programming languages: create entities for 'Python', 'JavaScript', and 'TypeScript'. Create edges: Python 'relates_to' JavaScript (both are popular languages), TypeScript 'depends_on' JavaScript (TypeScript is a superset). Then use memory_query_graph to traverse from TypeScript and report what you find.",
    evaluationCriteria: "The agent created KG entities and edges, then traversed the graph.",
    evaluatorType: "llm",
    evaluatorConfig: {
      criteria: "Did the agent use memory_link to create entities? Were edges created between entities? Did they use memory_query_graph to traverse? Does the traversal result show connected nodes? Score high for creating and traversing a real knowledge graph.",
      passThreshold: 0.65,
    },
    teaches: ["memory_link", "memory_query_graph", "knowledge graphs", "entity relationships"],
    requiredTools: ["memory_link", "memory_query_graph"],
    prerequisites: ["cross-project-memory"],
    maxAttempts: 3,
    timeoutMs: 300_000,
  },
  {
    id: "self-improve",
    name: "Self-Improvement",
    difficulty: "journeyman",
    category: "self_improvement",
    goal: "Use search_previous_attempts to look for patterns in your past bloop results. Identify one recurring pattern or improvement opportunity. Then either update an existing skill or create a new one using create_skill or update_skill that captures this pattern.",
    evaluationCriteria: "The agent searched past results, identified a pattern, and created/updated a skill.",
    evaluatorType: "llm",
    evaluatorConfig: {
      criteria: "Did the agent use search_previous_attempts? Did they identify a pattern from past work? Did they create or update a skill? Does the skill capture a useful, recurring pattern? Score high for demonstrating genuine self-improvement based on past performance.",
      passThreshold: 0.65,
    },
    teaches: ["search_previous_attempts", "create_skill", "update_skill", "meta-learning", "self-reflection"],
    requiredTools: ["search_previous_attempts", "create_skill"],
    prerequisites: ["create-first-skill"],
    maxAttempts: 3,
    timeoutMs: 300_000,
  },
  {
    id: "data-pipeline",
    name: "Data Pipeline",
    difficulty: "journeyman",
    category: "coding",
    goal: `Create a JSON data pipeline. First, write this JSON file to 'input.json':
[
  {"name": "Alice", "score": 85},
  {"name": "Bob", "score": 92},
  {"name": "Charlie", "score": 78},
  {"name": "Diana", "score": 95}
]

Then read it, transform it by adding a 'grade' field ('A' for score >= 90, 'B' for 80-89, 'C' for below 80), and write the transformed data to 'output.json'. Report the number of records processed.`,
    evaluationCriteria: "The agent read JSON data, transformed it correctly, and wrote the output.",
    evaluatorType: "llm",
    evaluatorConfig: {
      criteria: "Did the agent write input.json? Did they read and process it? Did they add grade fields correctly (Alice=B, Bob=A, Charlie=C, Diana=A)? Did they write output.json? Score high for correct data transformation.",
      passThreshold: 0.7,
    },
    teaches: ["data transformation", "read_file", "write_file", "JSON processing"],
    requiredTools: ["write_file", "read_file"],
    prerequisites: ["debug-script"],
    maxAttempts: 3,
    timeoutMs: 300_000,
  },
  {
    id: "verify-integrate",
    name: "Verify and Integrate",
    difficulty: "journeyman",
    category: "coding",
    goal: "Use the verify_and_integrate tool to build and validate a simple tool. First create a tool file called 'greet-tool.js' that exports a 'greet_user' tool which takes a 'name' parameter and returns 'Hello, {name}!'. Then use verify_and_integrate to validate and register it.",
    evaluationCriteria: "The agent created a tool file and used verify_and_integrate to register it.",
    evaluatorType: "llm",
    evaluatorConfig: {
      criteria: "Did the agent write a tool file with a valid tool definition? Did they use verify_and_integrate? Was there an attempt to register the tool? Score high for using the full build-verify-integrate pipeline.",
      passThreshold: 0.65,
    },
    teaches: ["verify_and_integrate", "tool validation", "tool registration", "build pipeline"],
    requiredTools: ["write_file", "verify_and_integrate"],
    prerequisites: ["build-a-tool"],
    maxAttempts: 3,
    timeoutMs: 600_000,
  },
];

// ── Expert (6 scenarios) ─────────────────────────────────────

const EXPERT_SCENARIOS: TrainingScenario[] = [
  {
    id: "architect-system",
    name: "Architect a System",
    difficulty: "expert",
    category: "planning",
    goal: "Design and partially implement a 3-component system: (1) a DataCollector component that reads files from a directory, (2) a DataProcessor component that transforms the data, (3) a DataReporter component that formats and outputs results. Write: architecture.md describing the design with clear interfaces, and stub implementation files for each component (collector.js, processor.js, reporter.js) with documented interfaces.",
    evaluationCriteria: "The agent created a coherent 3-component architecture with documented interfaces.",
    evaluatorType: "llm",
    evaluatorConfig: {
      criteria: "Did the agent create an architecture document? Are all 3 components described with clear interfaces? Were stub files created for each? Do the interfaces make sense together (outputs of one feed into the next)? Score high for a coherent, well-documented architecture with implementation stubs.",
      passThreshold: 0.7,
    },
    teaches: ["system design", "architecture", "interfaces", "write_file", "documentation"],
    requiredTools: ["write_file"],
    prerequisites: ["data-pipeline", "verify-integrate"],
    maxAttempts: 3,
    timeoutMs: 600_000,
  },
  {
    id: "teach-student",
    name: "Teach a Student",
    difficulty: "expert",
    category: "creativity",
    goal: "Write detailed, step-by-step instructions for how a junior agent should accomplish this complex task: 'Research a topic using web_fetch, store key facts in memory, build a knowledge graph of the topic, and create a skill for future use'. Write the instructions to 'teaching-guide.md'. The guide should be so clear that a junior agent with no prior knowledge could follow it.",
    evaluationCriteria: "The agent wrote clear, complete instructions covering all 4 major steps.",
    evaluatorType: "llm",
    evaluatorConfig: {
      criteria: "Did the agent write a guide file? Does it cover all 4 steps (web research, memory storage, knowledge graph, skill creation)? Are instructions specific enough to follow (mentioning tool names, parameters)? Would a junior agent understand? Score high for complete, actionable, well-structured instructions.",
      passThreshold: 0.7,
    },
    teaches: ["teaching", "documentation", "knowledge transfer", "write_file"],
    requiredTools: ["write_file"],
    prerequisites: ["knowledge-graph", "self-improve"],
    maxAttempts: 3,
    timeoutMs: 300_000,
  },
  {
    id: "meta-optimization",
    name: "Meta-Optimization",
    difficulty: "expert",
    category: "self_improvement",
    goal: "Perform a deep meta-cognitive analysis: (1) Search your memories for patterns and insights, (2) Identify 3+ recurring patterns or optimization opportunities, (3) Consolidate related memories that say the same thing, (4) Create or update a comprehensive skill that captures your most important learnings. Write a 'meta-analysis.md' documenting your findings.",
    evaluationCriteria: "The agent performed memory analysis, identified patterns, and created an optimized skill.",
    evaluatorType: "llm",
    evaluatorConfig: {
      criteria: "Did the agent search memories? Were patterns identified? Was a skill created or updated? Was a meta-analysis file written? Does the analysis show genuine meta-cognitive insight (patterns across multiple bloops, not just current state)? Score high for demonstrating real meta-cognition.",
      passThreshold: 0.7,
    },
    teaches: ["meta-cognition", "memory_search", "create_skill", "pattern recognition", "self-optimization"],
    requiredTools: ["memory_search", "create_skill", "write_file"],
    prerequisites: ["self-improve"],
    maxAttempts: 3,
    timeoutMs: 600_000,
  },
  {
    id: "concurrent-agents",
    name: "Concurrent Agents",
    difficulty: "expert",
    category: "planning",
    goal: "Use spawn_bloop to run 3 parallel research tasks simultaneously: (1) 'What are the key principles of functional programming', (2) 'What are the key principles of object-oriented programming', (3) 'What are the key principles of procedural programming'. Wait for all to complete using get_bloop_result. Then synthesize the results into a comprehensive comparison file 'paradigms-comparison.md'.",
    evaluationCriteria: "The agent spawned 3 parallel research bloops and synthesized their results.",
    evaluatorType: "llm",
    evaluatorConfig: {
      criteria: "Did the agent spawn 3 child bloops? Did it use get_bloop_result to collect results? Was a synthesis file created? Does it compare all 3 paradigms? Score high for actual parallel execution and coherent synthesis.",
      passThreshold: 0.7,
    },
    teaches: ["parallel execution", "spawn_bloop", "get_bloop_result", "synthesis", "concurrent agents"],
    requiredTools: ["spawn_bloop", "get_bloop_result", "write_file"],
    prerequisites: ["multi-step-plan"],
    maxAttempts: 3,
    timeoutMs: 900_000,
  },
  {
    id: "self-schedule",
    name: "Self-Schedule",
    difficulty: "expert",
    category: "self_improvement",
    goal: "Create a heartbeat monitoring schedule for yourself. Use create_schedule to set up a cron-based schedule that runs every hour (use '0 * * * *' as the cron expression) with the goal 'Heartbeat: check memory health, review recent bloops, identify any needed improvements'. After creating it, use list_schedules to verify it was created and report the schedule ID.",
    evaluationCriteria: "The agent created a cron schedule for self-monitoring.",
    evaluatorType: "contains",
    evaluatorConfig: { pattern: "schedule", passThreshold: 0.5 },
    teaches: ["create_schedule", "self-scheduling", "autonomous monitoring", "cron expressions"],
    requiredTools: ["create_schedule", "list_schedules"],
    prerequisites: ["meta-optimization"],
    maxAttempts: 3,
    timeoutMs: 180_000,
  },
  {
    id: "capstone",
    name: "Capstone Challenge",
    difficulty: "expert",
    category: "reasoning",
    goal: `Complete this real-world task that requires combining all your skills:

1. Research using web_fetch: Fetch https://example.com and https://httpbin.org/json, gather content from both
2. Memory: Store 2 key facts from your research
3. File operations: Create a report file 'capstone-report.md' with your findings organized in sections
4. Knowledge graph: Create entities for the 2 websites and link them with a 'relates_to' edge
5. Skill creation: Create a skill called 'web-research-workflow' that captures the process you just followed

Report completion of all 5 steps.`,
    evaluationCriteria: "The agent completed all 5 steps: web research, memory storage, file report, knowledge graph, and skill creation.",
    evaluatorType: "llm",
    evaluatorConfig: {
      criteria: "Did the agent complete all 5 steps? (1) web_fetch used for both URLs, (2) facts stored in memory, (3) report file created, (4) KG entities and edge created, (5) skill created. Score high for completing all steps with evidence of each.",
      passThreshold: 0.65,
    },
    teaches: ["integrated workflow", "all tools", "comprehensive task completion", "multi-step execution"],
    requiredTools: ["web_fetch", "memory_store", "write_file", "memory_link", "create_skill"],
    prerequisites: ["architect-system", "concurrent-agents", "self-schedule"],
    maxAttempts: 3,
    timeoutMs: 900_000,
  },
];

// ── Full Curriculum ───────────────────────────────────────────

export const DEFAULT_CURRICULUM: TrainingScenario[] = [
  ...NOVICE_SCENARIOS,
  ...APPRENTICE_SCENARIOS,
  ...JOURNEYMAN_SCENARIOS,
  ...EXPERT_SCENARIOS,
];

// ── Graduation Criteria ───────────────────────────────────────

export const GRADUATION_CRITERIA: GraduationCriteria = {
  minPassRateByLevel: {
    novice: 0.8,       // Pass 5/6 novice scenarios
    apprentice: 0.67,  // Pass 4/6 apprentice scenarios
    journeyman: 0.57,  // Pass 4/7 journeyman scenarios
    expert: 0.5,       // Pass 3/6 expert scenarios
  },
  requiredScenarioIds: [
    "memory-hello",     // Must understand memory basics
    "file-explorer",    // Must understand filesystem tools
    "capstone",         // Must complete the capstone
  ],
  minToolsCreated: 0,
  minSkillsCreated: 0,
};
