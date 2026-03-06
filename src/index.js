const fs = require("fs");
const { execSync } = require("child_process");
const axios = require("axios");
const OpenAI = require("openai");

// ── Configuration ────────────────────────────────────────────────────────────

const DIFF_CHAR_LIMIT = 15000;

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

  if (!slackWebhook) {
    throw new Error("Missing required input: slack_webhook");
  }
  if (!openaiApiKey) {
    throw new Error("Missing required input: openai_api_key");
  }
  if (!branch) {
    throw new Error("Missing required input: branch");
  }

  return { slackWebhook, openaiApiKey, branch };
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
 * Get the list of changed files between two commits, ignoring noisy paths.
 */
function getChangedFiles(beforeSha, afterSha) {
  const output = run(`git diff --name-status ${beforeSha} ${afterSha}`);
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
  // Build exclusion pathspec arguments
  const excludeArgs = IGNORED_PATTERNS.map(
    (p) => `":(exclude)${p}"`
  ).join(" ");

  const diff = run(
    `git diff ${beforeSha} ${afterSha} -- . ${excludeArgs}`
  );

  if (!diff) return "";

  // Truncate to stay within LLM context limits
  if (diff.length > DIFF_CHAR_LIMIT) {
    return diff.slice(0, DIFF_CHAR_LIMIT) + "\n\n[diff truncated]";
  }

  return diff;
}

/**
 * Send commit and diff data to OpenAI and return a generated changelog.
 */
async function generateChangelog(apiKey, commits, diff) {
  const client = new OpenAI({ apiKey });

  const commitSummary = commits
    .map((c) => `- ${c.message} (by ${c.author})`)
    .join("\n");

  const userMessage = `Generate a clear and concise changelog for the following code changes.

Guidelines:
* Use simple language
* Group related changes
* Highlight new features
* Highlight bug fixes
* Mention improvements
* Avoid referencing internal file paths unless necessary
* Format as a clean bullet list

Commits:
${commitSummary}

Code changes:
${diff}`;

  const response = await client.chat.completions.create({
    model: "gpt-4.1-mini",
    temperature: 0.2,
    messages: [
      {
        role: "system",
        content:
          "You are a senior software engineer writing changelogs for development teams.",
      },
      { role: "user", content: userMessage },
    ],
  });

  return response.choices[0].message.content;
}

/**
 * Post the changelog to Slack via an incoming webhook.
 */
async function postToSlack(webhookUrl, changelog) {
  const payload = {
    text: `*Repository Update*\n\n${changelog}`,
  };

  await axios.post(webhookUrl, payload, {
    headers: { "Content-Type": "application/json" },
  });
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("🚀 Pushlog — starting");

  // 1. Read inputs
  const { slackWebhook, openaiApiKey, branch } = getInputs();

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
  console.log("🤖 Generating changelog via OpenAI…");
  const changelog = await generateChangelog(openaiApiKey, commits, diff);

  console.log("─── Generated Changelog ───");
  console.log(changelog);
  console.log("────────────────────────────");

  // 7. Post to Slack
  console.log("📨 Posting changelog to Slack…");
  await postToSlack(slackWebhook, changelog);

  console.log("✅ Changelog posted to Slack successfully.");
}

main().catch((err) => {
  console.error("❌ Action failed:", err.message);
  process.exit(1);
});
