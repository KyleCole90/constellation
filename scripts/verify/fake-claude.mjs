#!/usr/bin/env node
import { readFileSync } from "node:fs";

const VERSION = "2.1.323";

const signedIn = () => {
  try {
    return (
      readFileSync(process.env.CONSTELLATION_FAKE_CLAUDE_STATE ?? "", "utf8").trim() === "signed-in"
    );
  } catch {
    return false;
  }
};

const [command, sub] = process.argv.slice(2);
if (command === "--version") {
  process.stdout.write(`${VERSION} (Claude Code)\n`);
} else if (command === "auth" && sub === "status") {
  const loggedIn = signedIn();
  process.stdout.write(
    `${JSON.stringify({ loggedIn, authMethod: loggedIn ? "claude.ai" : "none", apiProvider: "firstParty" })}\n`,
  );
} else {
  process.stderr.write(`fake claude: verify never runs ${JSON.stringify(process.argv.slice(2))}\n`);
  process.exitCode = 2;
}
