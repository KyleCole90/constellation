/** Project lint rules, loaded by `lint.jsPlugins` in vite.config.ts. */

import { dirname, normalize, resolve } from "node:path";

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
        "returning null on a bad shape (see `readDraftHosts` in src/renderer/components/settings/drafts.logic.ts).",
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

const isValibotCustom = (node) =>
  node.callee.type === "MemberExpression" &&
  node.callee.object.type === "Identifier" &&
  node.callee.object.name === "v" &&
  node.callee.property.type === "Identifier" &&
  node.callee.property.name === "custom";

const insideBrand = (node) => {
  for (let at = node.parent; at; at = at.parent)
    if (at.type === "VariableDeclarator" && at.id.type === "Identifier" && at.id.name === "brand")
      return true;
  return false;
};

/** An unannotated schema's type is whatever valibot infers, so the domain type can drift from it and still compile (#170). */
const annotatedSchemas = {
  meta: {
    type: "problem",
    messages: {
      unannotated:
        "Annotate `{{name}}` with its domain type, as in `const {{name}}: v.GenericSchema<T> = …` " +
        "(or `… satisfies v.GenericSchema<T>` where `v.variant` needs the object schema), so the schema fails to compile " +
        "when the type changes. A schema that is itself the type's only definition declares it with `v.InferOutput<typeof {{name}}>`.",
      custom:
        "`v.custom<T>` asserts `T` without checking it. Build the schema from valibot parts (`v.picklist`, `v.object`, …) " +
        "annotated with `v.GenericSchema<T>`, or mint a branded string with `brand<T>(check)`.",
    },
  },
  create(context) {
    const declarations = [];
    const definesType = new Set();
    return {
      Program(program) {
        for (const statement of program.body) {
          const declaration =
            statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
          if (declaration?.type === "VariableDeclaration")
            declarations.push(...declaration.declarations);
        }
      },
      TSTypeQuery(node) {
        const reference = node.parent?.parent;
        if (
          node.exprName.type === "Identifier" &&
          reference?.type === "TSTypeReference" &&
          reference.typeName.type === "TSQualifiedName" &&
          /^Infer(Output|Input)$/.test(reference.typeName.right.name)
        )
          definesType.add(node.exprName.name);
      },
      "Program:exit"() {
        for (const { id, init } of declarations) {
          if (id.type !== "Identifier" || !id.name.endsWith("Schema")) continue;
          if (
            id.typeAnnotation ||
            init?.type === "TSSatisfiesExpression" ||
            definesType.has(id.name)
          )
            continue;
          context.report({ node: id, messageId: "unannotated", data: { name: id.name } });
        }
      },
      CallExpression(node) {
        if (isValibotCustom(node) && !insideBrand(node))
          context.report({ node, messageId: "custom" });
      },
    };
  },
};

/** `never` fits every parameter, so a test that passes `x as never` keeps compiling after the signature changes (#177). */
const noAsNever = {
  meta: {
    type: "problem",
    messages: {
      never:
        "Don't cast to `never`: it fits any parameter, so the test can't notice a signature change. " +
        "Pass a real value: an exported constant or fixture (`LCC` in tests/fixtures/rig.ts), a parsed id, " +
        "or narrow the union on its `kind`; throw when a fixture is missing.",
    },
  },
  create(context) {
    const check = (node) => {
      if (node.typeAnnotation.type === "TSNeverKeyword")
        context.report({ node, messageId: "never" });
    };
    return { TSAsExpression: check, TSTypeAssertion: check };
  },
};

const PROCESS_FOLDER = /(?:^|\/)src\/(main|preload|renderer|shared)\//i;
const processOf = (path) => PROCESS_FOLDER.exec(path)?.[1]?.toLowerCase() ?? null;

/** Each process folder imports only itself and `src/shared`, so main-only or renderer-only code can't leak across. */
const processBoundary = {
  meta: {
    type: "problem",
    messages: {
      cross:
        "`src/{{from}}` can't import from `src/{{to}}`. A process folder imports only itself and `src/shared`. " +
        "Move what both sides need into `src/shared`.",
    },
  },
  create(context) {
    const from = processOf(context.filename);
    if (!from) return {};
    const check = (source) => {
      const spec = source?.value;
      if (typeof spec !== "string") return;
      const to = spec.startsWith("~/")
        ? processOf(normalize(`src/${spec.slice(2)}/`))
        : spec.startsWith(".")
          ? processOf(`${resolve(dirname(context.filename), spec)}/`)
          : null;
      if (to && to !== from && to !== "shared")
        context.report({ node: source, messageId: "cross", data: { from, to } });
    };
    return {
      ImportDeclaration: (node) => check(node.source),
      ExportNamedDeclaration: (node) => check(node.source),
      ExportAllDeclaration: (node) => check(node.source),
      ImportExpression: (node) => check(node.source),
      TSImportType: (node) => check(node.source ?? node.argument?.literal),
    };
  },
};

export default {
  meta: { name: "constellation" },
  rules: {
    "no-vp-server-spawn": noVpServerSpawn,
    "no-json-parse-cast": noJsonParseCast,
    "process-boundary": processBoundary,
    "annotated-schemas": annotatedSchemas,
    "no-as-never": noAsNever,
  },
};
