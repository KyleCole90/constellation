# Privacy

Constellation runs on your Mac. There is no Constellation server, and no account with us. Your schools' data stays on this Mac, except for the things below.

## What leaves this Mac

1. **Canvas calls to your school.** The app reads and writes your courses at the school address you enter, with the token you paste. A change reaches Canvas only after you approve it.
2. **Anthropic calls with your key.** If you add an Anthropic API key, the app sends Anthropic what each draft or chat needs, such as a submission, a conversation or a course's details. Anthropic bills those calls to your key. With no key, nothing goes to Anthropic this way.
3. **Anthropic calls through your Claude Code.** If you choose Claude Code, the app runs the Claude Code installed on your Mac for each draft or chat, and it sends Anthropic the same things under your own Claude subscription. Those calls count against your plan's limits. You sign in to Claude Code yourself, in Anthropic's own flow. Constellation never asks for, sees or stores your Claude login.
4. **Usage data and scrubbed crash reports to PostHog.** The app tells PostHog, an analytics service, which parts of the app you use, so we can see where teachers get stuck. It sends only these events, each with fixed words and counts, never text:
   - the app opened;
   - a setup step finished (welcome or setup), with which AI source you had chosen, and setup finished;
   - you changed your AI source, from which to which (none, your key, Claude Code);
   - you asked for a draft of a grade, reply, announcement or message, and whether you approved it as written, approved it after editing, discarded it, Claude's answer was refused as invalid, or your Claude plan's limit stopped it;
   - how many grades one send posted.

   When the app hits an error, it sends the kind of error it was, the files and line numbers in the app's own code where it happened, the app version, and the macOS version. It never sends the error's message, and it treats every other value as student data and drops it.

   Never sent: student names, IDs, emails, grades, submissions, comments, message bodies, course content, LMS tokens, and institution URLs. Events carry no account, no name, no IP-based location, no screen recordings and no record of what you clicked. A random ID made when the app first sends groups this Mac's events, and names no one.

Usage data and crash reports are on by default, and only the installed app sends them. To turn them off, clear **Send usage data and crash reports** on the setup page or in **Settings**, under **Privacy**. Turning it off stops sending at once, and drops anything not yet sent.

## What stays on this Mac

Your school tokens and your Anthropic key are encrypted with a key kept in your Mac's Keychain. Your workspace (threads, drafts, grades you've entered, settings) is stored in the app's data folder and is not encrypted. Anyone who can sign in to your Mac account can read it, so keep that account protected.

## What this is not

Constellation makes no claim of FERPA compliance. You are responsible for following your school's rules for student data.
