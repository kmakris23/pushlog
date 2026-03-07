const fs = require("fs");
const { execSync, execFileSync } = require("child_process");
const axios = require("axios");
const OpenAI = require("openai");

// ── Configuration ────────────────────────────────────────────────────────────

const DIFF_CHAR_LIMIT = 15000;
const DEFAULT_OPENAI_MODEL = "gpt-4.1";
const DEFAULT_OPENAI_TEMPERATURE = 0.1;
const DEFAULT_OPENAI_MAX_OUTPUT_TOKENS = 800;

const LANGUAGE_NAMES = {
  en: "English",
  el: "Greek",
  fr: "French",
  de: "German",
  es: "Spanish",
  it: "Italian",
  pt: "Portuguese",
  "pt-br": "Brazilian Portuguese",
  nl: "Dutch",
  pl: "Polish",
  tr: "Turkish",
  ru: "Russian",
  uk: "Ukrainian",
  cs: "Czech",
  ro: "Romanian",
  hu: "Hungarian",
  bg: "Bulgarian",
  sv: "Swedish",
  da: "Danish",
  fi: "Finnish",
  no: "Norwegian",
  ja: "Japanese",
  ko: "Korean",
  zh: "Chinese",
  "zh-cn": "Simplified Chinese",
  "zh-tw": "Traditional Chinese",
};

const DEFAULT_SYSTEM_PROMPT = `You are Pushlog, an AI assistant that writes changelogs for GitHub repository pushes.
Your task is to turn commit metadata and code diffs into a concise, channel-agnostic changelog.

Requirements:
- Use simple language
- Group related changes
- Highlight new features
- Highlight bug fixes
- Mention improvements
- Avoid referencing internal file paths unless necessary
- Format the result as a clean bullet list
- Follow any additional user instructions unless they conflict with these requirements or the provided repository context`;

const DEFAULT_USER_PROMPT = "Generate a clear and concise changelog for these changes.";

const IGNORED_PATTERNS = [
  "node_modules",
  "dist",
  "build",
  "package-lock.json",
  "yarn.lock",
];

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Read action inputs from environment variables set by GitHub Actions.
 */
function getInputs() {
  const slackWebhook = process.env.INPUT_SLACK_WEBHOOK;
  const openaiApiKey = process.env.INPUT_OPENAI_API_KEY;
  const branch = process.env.INPUT_BRANCH;
  const language = process.env.INPUT_LANGUAGE || "en";
  const slackTitle = process.env.INPUT_SLACK_TITLE || "Repository Update";
  const slackMentions = process.env.INPUT_SLACK_MENTIONS || "";
  const openaiModel = (process.env.INPUT_OPENAI_MODEL || DEFAULT_OPENAI_MODEL).trim();
  const openaiTemperature = parseNumberInput(
    process.env.INPUT_OPENAI_TEMPERATURE,
    DEFAULT_OPENAI_TEMPERATURE,
    "openai_temperature",
    { min: 0, max: 2 }
  );
  const openaiMaxOutputTokens = parseNumberInput(
    process.env.INPUT_OPENAI_MAX_OUTPUT_TOKENS,
    DEFAULT_OPENAI_MAX_OUTPUT_TOKENS,
    "openai_max_output_tokens",
    { integer: true, min: 1 }
  );
  const userPrompt = (process.env.INPUT_USER_PROMPT || process.env.INPUT_CUSTOM_PROMPT || "").trim();
  const systemPrompt = (process.env.INPUT_SYSTEM_PROMPT || "").trim();

  if (!slackWebhook) {
    throw new Error("Missing required input: slack_webhook");
  }
  if (!openaiApiKey) {
    throw new Error("Missing required input: openai_api_key");
  }
  if (!branch) {
    throw new Error("Missing required input: branch");
  }
  if (!openaiModel) {
    throw new Error("Missing required input: openai_model");
  }

  return {
    slackWebhook,
    openaiApiKey,
    branch,
    language,
    slackTitle,
    slackMentions,
    openaiModel,
    openaiTemperature,
    openaiMaxOutputTokens,
    userPrompt,
    systemPrompt,
  };
}

/**
 * Parse a numeric action input with validation.
 */
function parseNumberInput(rawValue, fallback, inputName, options = {}) {
  if (rawValue === undefined || rawValue === null || String(rawValue).trim() === "") {
    return fallback;
  }

  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid input: ${inputName} must be a number`);
  }
  if (options.integer && !Number.isInteger(parsed)) {
    throw new Error(`Invalid input: ${inputName} must be an integer`);
  }
  if (options.min !== undefined && parsed < options.min) {
    throw new Error(`Invalid input: ${inputName} must be >= ${options.min}`);
  }
  if (options.max !== undefined && parsed > options.max) {
    throw new Error(`Invalid input: ${inputName} must be <= ${options.max}`);
  }

  return parsed;
}

/**
 * Load and parse the GitHub push event payload.
 */
function loadEvent() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) {
    throw new Error("GITHUB_EVENT_PATH is not set. Is this running inside GitHub Actions?");
  }

  const raw = fs.readFileSync(eventPath, "utf8");
  return JSON.parse(raw);
}

/**
 * Run a shell command and return trimmed stdout.
 * Returns null when the command fails (e.g. invalid SHA range).
 */
function run(cmd) {
  try {
    return execSync(cmd, { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 }).trim();
  } catch {
    return null;
  }
}

/**
 * Run git with an array of arguments (avoids shell interpretation issues).
 * Returns null when the command fails.
 */
function git(...args) {
  try {
    return execFileSync("git", args, { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 }).trim();
  } catch {
    return null;
  }
}

// ── Core Logic ───────────────────────────────────────────────────────────────

/**
 * Extract structured commit information from the push event payload.
 */
function extractCommits(event) {
  const commits = event.commits || [];
  return commits.map((c) => ({
    id: c.id,
    message: c.message,
    author: c.author?.name || c.author?.username || "unknown",
    added: c.added || [],
    modified: c.modified || [],
    removed: c.removed || [],
  }));
}

/**
 * Determine the branch name from the event ref (refs/heads/<branch>).
 */
function getBranchFromRef(ref) {
  return (ref || "").replace("refs/heads/", "");
}

/**
 * Check if the before SHA is valid (not all zeros, which indicates the first push).
 */
function isInitialPush(beforeSha) {
  return !beforeSha || /^0+$/.test(beforeSha);
}

/**
 * Build the diff range. On the first push the "before" SHA is all zeros,
 * so we fall back to diffing against the parent of the earliest commit.
 */
function getDiffRange(beforeSha, afterSha) {
  if (isInitialPush(beforeSha)) {
    // First push — diff the entire tree introduced by afterSha
    const firstCommit = git("rev-list", "--max-parents=0", afterSha);
    if (!firstCommit) return null;
    return { from: `${firstCommit}^`, to: afterSha, useEmpty: true };
  }
  return { from: beforeSha, to: afterSha, useEmpty: false };
}

/**
 * Get the list of changed files between two commits, ignoring noisy paths.
 */
function getChangedFiles(beforeSha, afterSha) {
  const range = getDiffRange(beforeSha, afterSha);
  if (!range) return [];

  const from = range.useEmpty
    ? "4b825dc642cb6eb9a060e54bf899d69f82cf7006"
    : range.from;

  const output = git("diff", "--name-status", from, range.to);
  if (!output) return [];

  return output
    .split("\n")
    .filter((line) => line.trim())
    .filter((line) => {
      const filePath = line.split("\t").slice(1).join("\t");
      return !IGNORED_PATTERNS.some((p) => filePath.includes(p));
    });
}

/**
 * Get the code diff between two commits, filtered and truncated.
 */
function getCodeDiff(beforeSha, afterSha) {
  const range = getDiffRange(beforeSha, afterSha);
  if (!range) return "";

  const from = range.useEmpty
    ? "4b825dc642cb6eb9a060e54bf899d69f82cf7006"
    : range.from;

  // Build args array — using execFileSync avoids shell interpretation of :(exclude)
  const args = ["diff", from, range.to, "--", "."];
  for (const p of IGNORED_PATTERNS) {
    args.push(`:(exclude)${p}`);
  }

  const diff = git(...args);
  if (!diff) return "";

  // Truncate to stay within LLM context limits
  if (diff.length > DIFF_CHAR_LIMIT) {
    return diff.slice(0, DIFF_CHAR_LIMIT) + "\n\n[diff truncated]";
  }

  return diff;
}

/**
 * Resolve a language code to a human-readable instruction for the model.
 */
function getLanguageInstruction(language) {
  const normalizedLanguage = (language || "en").trim().toLowerCase();
  const languageName = LANGUAGE_NAMES[normalizedLanguage];

  if (languageName) {
    return `Write the final output entirely in ${languageName} (language code: ${normalizedLanguage}). Do not default to English.`;
  }

  return `Write the final output entirely in the requested language (language code: ${normalizedLanguage}). Do not default to English.`;
}

/**
 * Build the system prompt that defines the changelog behavior.
 */
function buildSystemPrompt(language, systemPrompt) {
  const prompt = systemPrompt || DEFAULT_SYSTEM_PROMPT;
  return `${prompt}\n\n${getLanguageInstruction(language)}`;
}

/**
 * Build the user prompt by combining optional user instructions with commit and diff context.
 */
function buildUserPrompt(userPrompt, language, commitSummary, diff) {
  const userInstructions = userPrompt || DEFAULT_USER_PROMPT;

  return `${userInstructions}\n\nRequested output language:\n${getLanguageInstruction(language)}\n\nCommits:\n${commitSummary}\n\nCode changes:\n${diff}`;
}

/**
 * Extract plain text from a Responses API result.
 */
function extractResponsesText(response) {
  if (typeof response.output_text === "string" && response.output_text.trim()) {
    return response.output_text.trim();
  }

  const textParts = [];
  for (const item of response.output || []) {
    for (const content of item.content || []) {
      if (content.type === "output_text" && content.text) {
        textParts.push(content.text);
      }
    }
  }

  return textParts.join("\n").trim();
}

/**
 * Send commit and diff data to OpenAI and return a generated changelog.
 */
async function generateChangelog(
  apiKey,
  commits,
  diff,
  language,
  userPrompt,
  systemPrompt,
  openaiModel,
  openaiTemperature,
  openaiMaxOutputTokens
) {
  const client = new OpenAI({ apiKey });

  const commitSummary = commits
    .map((c) => `- ${c.message} (by ${c.author})`)
    .join("\n");

  const systemMessage = buildSystemPrompt(language, systemPrompt);
  const userMessage = buildUserPrompt(userPrompt, language, commitSummary, diff);

  try {
    const response = await client.responses.create({
      model: openaiModel,
      temperature: openaiTemperature,
      max_output_tokens: openaiMaxOutputTokens,
      input: [
        {
          role: "system",
          content: [{ type: "input_text", text: systemMessage }],
        },
        {
          role: "user",
          content: [{ type: "input_text", text: userMessage }],
        },
      ],
    });

    const outputText = extractResponsesText(response);
    if (outputText) {
      return outputText;
    }

    console.warn("OpenAI Responses API returned empty output. Falling back to Chat Completions.");
  } catch (error) {
    console.warn(`OpenAI Responses API failed: ${error.message}. Falling back to Chat Completions.`);
  }

  const response = await client.chat.completions.create({
    model: openaiModel,
    temperature: openaiTemperature,
    max_tokens: openaiMaxOutputTokens,
    messages: [
      {
        role: "system",
        content: systemMessage,
      },
      { role: "user", content: userMessage },
    ],
  });

  const content = response.choices[0]?.message?.content?.trim();
  if (!content) {
    throw new Error("OpenAI returned an empty changelog");
  }

  return content;
}

/**
 * Post the changelog to Slack via an incoming webhook.
 */
async function postToSlack(webhookUrl, changelog, title, mentions, branch) {
  const mentionLine = mentions ? `${mentions}\n\n` : "";
  const payload = {
    text: `${mentionLine}*${title}* (\`${branch}\`)\n\n${changelog}`,
  };

  await axios.post(webhookUrl, payload, {
    headers: { "Content-Type": "application/json" },
  });
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("🚀 Pushlog — starting");

  // Mark /github/workspace as safe so git works inside the Docker container
  run("git config --global --add safe.directory /github/workspace");

  // 1. Read inputs
  const {
    slackWebhook,
    openaiApiKey,
    branch,
    language,
    slackTitle,
    slackMentions,
    openaiModel,
    openaiTemperature,
    openaiMaxOutputTokens,
    userPrompt,
    systemPrompt,
  } = getInputs();

  // 2. Load push event payload
  const event = loadEvent();
  const pushBranch = getBranchFromRef(event.ref);
  const repoName = event.repository?.full_name || "unknown";

  console.log(`📦 Repository: ${repoName}`);
  console.log(`🌿 Push branch: ${pushBranch} (monitoring: ${branch})`);

  // 3. Verify the push is on the monitored branch
  if (pushBranch !== branch) {
    console.log(`⏭️  Push is not on the monitored branch (${branch}). Skipping.`);
    process.exit(0);
  }

  // 4. Extract commit data from the event
  const beforeSha = event.before;
  const afterSha = event.after;
  const commits = extractCommits(event);

  if (commits.length === 0) {
    console.log("ℹ️  No commits found in push event. Nothing to do.");
    process.exit(0);
  }

  console.log(`📝 Commits: ${commits.length}`);
  commits.forEach((c) => console.log(`   • ${c.id.slice(0, 7)} ${c.message}`));

  // 5. Gather code changes via git diff
  console.log(`🔍 Computing diff ${beforeSha.slice(0, 7)}..${afterSha.slice(0, 7)}`);
  const changedFiles = getChangedFiles(beforeSha, afterSha);
  const diff = getCodeDiff(beforeSha, afterSha);

  console.log(`📂 Changed files: ${changedFiles.length}`);

  if (!diff) {
    console.log("ℹ️  No meaningful code diff found. Skipping changelog generation.");
    process.exit(0);
  }

  // 6. Generate changelog with OpenAI
  console.log(`🤖 Generating changelog via OpenAI (${openaiModel})…`);
  const changelog = await generateChangelog(
    openaiApiKey,
    commits,
    diff,
    language,
    userPrompt,
    systemPrompt,
    openaiModel,
    openaiTemperature,
    openaiMaxOutputTokens
  );

  console.log("─── Generated Changelog ───");
  console.log(changelog);
  console.log("────────────────────────────");

  // 7. Post to Slack
  console.log("📨 Posting changelog to Slack…");
  await postToSlack(slackWebhook, changelog, slackTitle, slackMentions, pushBranch);

  console.log("✅ Changelog posted to Slack successfully.");
}

main().catch((err) => {
  console.error("❌ Action failed:", err.message);
  process.exit(1);
});
