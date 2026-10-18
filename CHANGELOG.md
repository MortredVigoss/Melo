# Changelog

A brief overview of user-facing updates. Technical details live in the project documentation and commit history.

## 2026-10-18 — iPhone 0.7.0 (32)

- Date continuity: the prompt now says that earlier messages were written at their own time, and when a conversation crosses midnight the turn carries a short note ("the previous message was sent yesterday") — the model no longer "corrects" a previous reply's "今天". iPhone requests now include the current local date (they carried none).
- iPhone auto-read: speaks a condensed version of the reply (conclusions and numbers; no URLs, link targets, code, tables or markdown), and picks the voice by the reply's own language first (Chinese replies in Chinese on an English phone), then the voice-language setting, then the device language. The setting is now labelled "语音语言（听写与朗读）".
- Tool groups: browser tools are available from the first turn whenever `MELO_CDP_ENABLED=1` (as before the stable-tool-set change); image/document groups also activate from earlier attachments in the chat and from wording such as 截图 / 预览 / 放大 / 文档 / 报告.

## 2026-10-17

- Improved model and tool compatibility, with clearer execution feedback and limits.
- Better handling of long conversations, earlier topics, and large attachments.
- Shared project memory and personal preferences, with controls for what Melo remembers.
- Improved iPhone conversation sync and memory conflict handling.
- Temporarily archived Telegram and Discord integrations, preserving existing settings and history.

When updating, keep your existing data directory. See [Run from source](README.md#run-from-source) for installation steps.
