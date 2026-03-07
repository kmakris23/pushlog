# Pushlog

A Docker-based GitHub Action that generates AI-powered changelogs from commits and code changes and posts them to Slack.

When a push occurs on a configured branch, the action:

1. Collects commit messages and metadata from the push event.
2. Extracts the code diff between the before/after commits.
3. Sends the data to the OpenAI API to generate a human-friendly changelog.
4. Posts the changelog to a Slack channel via webhook.

The changelog is written in plain language, understandable by both developers and non-technical stakeholders.

---

## Required Secrets

| Secret            | Description                              |
| ----------------- | ---------------------------------------- |
| `SLACK_WEBHOOK`   | Slack incoming webhook URL               |
| `OPENAI_API_KEY`  | OpenAI API key with access to GPT models |

---

## Inputs

| Input            | Required | Default | Description          |
| ---------------- | -------- | ------- | -------------------- |
| `slack_webhook`  | Yes      | —       | Slack webhook URL    |
| `openai_api_key` | Yes      | —       | OpenAI API key       |
| `branch`         | Yes      | —       | Branch to monitor    |
| `language`       | No       | `en`    | Changelog language code (e.g. en, el, fr, de) |
| `openai_model`   | No       | `gpt-4.1` | OpenAI model to use for changelog generation |
| `openai_temperature` | No   | `0.1`   | Sampling temperature for changelog generation |
| `openai_max_output_tokens` | No | `800` | Maximum number of output tokens |
| `slack_title`    | No       | `Repository Update` | Title for the Slack message |
| `slack_mentions` | No       | —       | Slack mentions (e.g. `<!channel>`, `<!here>`, `<@U012345>`) |
| `user_prompt`    | No       | —       | Freeform extra instructions for changelog generation |
| `system_prompt`  | No       | —       | Optional system prompt override for the model behavior |

### Prompt Inputs

You can provide `user_prompt` as plain instructions.

Pushlog always sends the required context on its own:

- What the tool is doing
- Which language to use
- The commit summary
- The filtered code diff

That means users do not need placeholders or prompt templates. Whatever you put in `user_prompt` is treated as additional guidance layered on top of the default behavior.

You can also override `system_prompt` if you want to change the base model behavior. Pushlog still injects the selected language automatically.

### OpenAI Settings

Pushlog now uses the OpenAI Responses API first and falls back to Chat Completions if needed.

- `openai_model`: controls quality, speed, and cost. The default is `gpt-4.1` for stronger output quality.
- `openai_temperature`: lower values make the result more consistent. The default is `0.1`.
- `openai_max_output_tokens`: caps the response size. The default is `800`.

---

## Example Workflow

```yaml
name: Pushlog

on:
  push:
    branches:
      - main

jobs:
  changelog:
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: kmakris23/pushlog@v1
        with:
          slack_webhook: ${{ secrets.SLACK_WEBHOOK }}
          openai_api_key: ${{ secrets.OPENAI_API_KEY }}
          branch: main
          language: en
          openai_model: gpt-4.1
          slack_title: Repository Update
          slack_mentions: '<!channel>'
```

### Example With User Prompt

```yaml
name: Pushlog

on:
  push:
    branches:
      - main

jobs:
  changelog:
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: kmakris23/pushlog@v1
        with:
          slack_webhook: ${{ secrets.SLACK_WEBHOOK }}
          openai_api_key: ${{ secrets.OPENAI_API_KEY }}
          branch: main
          user_prompt: |
            Focus on user-facing impact first.
            Group the result into New Features, Fixes, and Maintenance.
            Keep each bullet short.
```

### Example With System Prompt Override

```yaml
name: Pushlog

on:
  push:
    branches:
      - main

jobs:
  changelog:
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: kmakris23/pushlog@v1
        with:
          slack_webhook: ${{ secrets.SLACK_WEBHOOK }}
          openai_api_key: ${{ secrets.OPENAI_API_KEY }}
          branch: main
          system_prompt: |
            You write release notes for engineering teams.
            Prefer crisp bullets and group related changes by theme.
            Focus on observable impact and skip low-value implementation details.
          user_prompt: |
            Keep the output compact.
```

> **Important:** `fetch-depth: 0` is required so the action can compute diffs across the full commit history.

---

## Example Slack Output

```
@channel

Repository Update (main)

New Features
• Added login API with JWT authentication

Bug Fixes
• Fixed issue where duplicate orders could be created

Improvements
• Refactored invoice service for better maintainability
```

---

## How It Works

1. Reads the GitHub push event payload from `GITHUB_EVENT_PATH`.
2. Extracts commit messages, authors, and file change metadata.
3. Runs `git diff` between the before and after SHAs.
4. Filters out noisy paths (`node_modules`, `dist`, `build`, lock files).
5. Truncates the diff to 15 000 characters to fit LLM context limits.
6. Sends the commit list and diff to OpenAI using the Responses API first, with a fallback to Chat Completions.
7. Posts the generated changelog to Slack.

---

## License

MIT
