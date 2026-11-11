/** Project lint rules, loaded by `lint.jsPlugins` in vite.config.ts. */

const MESSAGE =
  "Don't spawn `vp {{command}}` as a child process: `vp` doesn't forward SIGTERM, so vite outlives it and keeps the port (#138, #142). " +
  "Serve in-process with vite's JS API: `createServer(...).listen()` (scripts/dev-server.mjs) or `preview(...)`.";

const SERVERS = new Set(["dev", "preview", "serve"]);
const VP_BINARY = /(^|\/)vp$/;
const VP_SERVER_COMMAND = /(^|[\s/])vp\s+(dev|preview|serve)\b/;

const noVpServerSpawn = {
  meta: { type: "problem", messages: { spawn: MESSAGE } },
  create(context) {
    let spawnsProcesses = false;
    let namesVp = false;
    const servers = [];
    const visitString = (node, value) => {
      const command = VP_SERVER_COMMAND.exec(value);
      if (command || VP_BINARY.test(value)) namesVp = true;
      if (command) servers.push({ node, command: command[2] });
      else if (SERVERS.has(value) && node.parent?.type === "ArrayExpression")
        servers.push({ node, command: value });
    };
    return {
      ImportDeclaration(node) {
        if (/^(node:)?child_process$/.test(node.source.value)) spawnsProcesses = true;
      },
      Literal(node) {
        if (typeof node.value === "string") visitString(node, node.value);
      },
      TemplateElement(node) {
        visitString(node, node.value.cooked ?? node.value.raw);
      },
      "Program:exit"() {
        if (!spawnsProcesses || !namesVp) return;
        for (const { node, command } of servers)
          context.report({ node, messageId: "spawn", data: { command } });
      },
    };
  },
};

const isJsonParse = (node) =>
  node.type === "CallExpression" &&
  node.callee.type === "MemberExpression" &&
  node.callee.object.type === "Identifier" &&
  node.callee.object.name === "JSON" &&
  node.callee.property.type === "Identifier" &&
  node.callee.property.name === "parse";

const isCast = (node) => node.type === "TSAsExpression" || node.type === "TSTypeAssertion";

/** `JSON.parse` returns `any`, so a cast on it claims a shape nothing checked. The no-unsafe-* rules miss this one. */
const noJsonParseCast = {
  meta: {
    type: "problem",
    messages: {
      cast:
        "Don't cast `JSON.parse` output. Type it `unknown` and parse it into the domain type, " +
        "returning null on a bad shape (see `readDraftHosts` in src/components/settings/drafts.logic.ts).",
    },
  },
  create(context) {
    const check = (node) => {
      if (node.typeAnnotation.type === "TSUnknownKeyword") return;
      let inner = node.expression;
      while (isCast(inner)) inner = inner.expression;
      if (isJsonParse(inner)) context.report({ node, messageId: "cast" });
    };
    return { TSAsExpression: check, TSTypeAssertion: check };
  },
};

export default {
  meta: { name: "constellation" },
  rules: { "no-vp-server-spawn": noVpServerSpawn, "no-json-parse-cast": noJsonParseCast },
};
