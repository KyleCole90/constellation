# Privacy

Constellation runs on your Mac. There is no Constellation server, and no account with us. Your schools' data stays on this Mac, except for the things below.

## What leaves this Mac

1. **Canvas calls to your school.** The app reads and writes your courses at the school address you enter, with the token you paste. A change reaches Canvas only after you approve it.
2. **Anthropic calls with your key.** If you add an Anthropic API key, the app sends Anthropic what each draft or chat needs, such as a submission, a conversation or a course's details. Anthropic bills those calls to your key. With no key, nothing goes to Anthropic this way.
3. **Anthropic calls through your Claude Code.** If you choose Claude Code, the app runs the Claude Code installed on your Mac for each draft or chat, and it sends Anthropic the same things under your own Claude subscription. Those calls count against your plan's limits. You sign in to Claude Code yourself, in Anthropic's own flow. Constellation never asks for, sees or stores your Claude login.
4. **Scrubbed crash reports to PostHog.** When the app hits an error, it sends PostHog, an error-tracking service, the kind of error it was, the files and line numbers in the app's own code where it happened, the app version, and the macOS version. It never sends the error's message, and it treats every other value as student data and drops it. Reports carry no account, no name, no IP-based location, no screen recordings and no record of what you clicked. A new random ID each launch groups one launch's reports.

Crash reports are on by default. To turn them off, clear **Send crash reports** on the setup page or in **Settings**, under **Privacy**.

## What stays on this Mac

Your school tokens and your Anthropic key are encrypted with a key kept in your Mac's Keychain. Your workspace (threads, drafts, grades you've entered, settings) is stored in the app's data folder and is not encrypted. Anyone who can sign in to your Mac account can read it, so keep that account protected.

## What this is not

Constellation makes no claim of FERPA compliance. You are responsible for following your school's rules for student data.
