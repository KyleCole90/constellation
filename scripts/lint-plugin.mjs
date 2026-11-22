import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, normalize, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { BASELINE, counts, readBaseline } from "./comments.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

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

const unparen = (node) =>
  node.type === "ParenthesizedExpression" ? unparen(node.expression) : node;

const TEST_FILE = /(?:^|\/)tests\/|\.test\.ts$/;

const noDoubleAssertion = {
  meta: {
    type: "problem",
    messages: {
      double:
        "Don't cast twice (`as unknown as T`, `as X as T`): it forces a type the compiler can't relate to the value (#165, #166). " +
        "Build a real `T` (a fixture builder, the type's own constructor) or parse it into `T`.",
      test:
        "Don't cast twice (`as unknown as T`, `as X as T`): build a real `T` (a fixture builder, a full literal). " +
        "A test that forges what the type exists to stop (an ApprovalWitness, a SendPermit) says so in a `// forged: <why>` comment on the line above.",
    },
  },
  create(context) {
    const inTest = TEST_FILE.test(context.filename);
    const forgedLines = new Set(
      inTest
        ? context.sourceCode
            .getAllComments()
            .filter((comment) => /^\s*forged:/.test(comment.value))
            .map((comment) => comment.loc.end.line)
        : [],
    );
    const check = (node) => {
      if (!isCast(unparen(node.expression))) return;
      const line = node.loc.start.line;
      if (forgedLines.has(line - 1) || forgedLines.has(line)) return;
      context.report({ node, messageId: inTest ? "test" : "double" });
    };
    return { TSAsExpression: check, TSTypeAssertion: check };
  },
};

const declaredBrands = (srcDir) =>
  new Set(
    readdirSync(srcDir, { recursive: true, encoding: "utf8" })
      .filter((file) => file.endsWith(".ts"))
      .flatMap((file) =>
        [
          ...readFileSync(join(srcDir, file), "utf8").matchAll(
            /^export type (\w+)(?:<[^>]*>)? = Brand</gm,
          ),
        ].map((match) => match[1]),
      ),
  );

const BRANDS = declaredBrands(join(ROOT, "src"));

const brandIn = (type) => {
  switch (type.type) {
    case "TSTypeReference":
      return type.typeName.type === "Identifier" && BRANDS.has(type.typeName.name)
        ? type.typeName.name
        : null;
    case "TSArrayType":
      return brandIn(type.elementType);
    case "TSTypeOperator":
      return type.typeAnnotation ? brandIn(type.typeAnnotation) : null;
    case "TSUnionType":
      for (const member of type.types) {
        const brand = brandIn(member);
        if (brand) return brand;
      }
      return null;
    default:
      return null;
  }
};

const isToIsoString = (node) =>
  node.type === "CallExpression" &&
  node.callee.type === "MemberExpression" &&
  node.callee.property.type === "Identifier" &&
  node.callee.property.name === "toISOString";
const isStringLiteral = (node) =>
  (node.type === "Literal" && typeof node.value === "string") ||
  (node.type === "TemplateLiteral" && node.expressions.length === 0);
const castsToIsoTime = (node) =>
  brandIn(node.typeAnnotation) === "IsoTime" &&
  (isToIsoString(unparen(node.expression)) || isStringLiteral(unparen(node.expression)));

const MINT_FILE =
  /(?:^|\/)(?:src\/shared\/domain\/(?:ids|term|approval|scan)|src\/shared\/providers\/canvas-refs|tests\/fixtures\/ids)\.ts$/;

const noBrandCast = {
  meta: {
    type: "problem",
    messages: {
      brand:
        "Don't cast to `{{brand}}`: a brand stands for a check, and a cast skips it. " +
        "Use its mint or parser (`parseSchoolId`, `isoTime`, `riskKey`, `v.parse(ThreadIdSchema, …)`). " +
        "Tests use the mints in tests/fixtures/ids.ts.",
    },
  },
  create(context) {
    if (MINT_FILE.test(context.filename)) return {};
    const check = (node) => {
      if (castsToIsoTime(node)) return;
      const brand = brandIn(node.typeAnnotation);
      if (brand) context.report({ node, messageId: "brand", data: { brand } });
    };
    return { TSAsExpression: check, TSTypeAssertion: check };
  },
};

const useIsoTime = {
  meta: {
    type: "problem",
    messages: {
      isoTime:
        "Use `isoTime()` from src/shared/domain/ids.ts instead of casting to IsoTime: it writes the one format the brand promises (`.sssZ`), and throws on an invalid time (#175).",
    },
  },
  create(context) {
    const check = (node) => {
      if (castsToIsoTime(node)) context.report({ node, messageId: "isoTime" });
    };
    return { TSAsExpression: check, TSTypeAssertion: check };
  },
};

const allowedComments = readBaseline();

const noComments = {
  meta: {
    type: "problem",
    messages: {
      comment:
        "{{path}} has {{actual}} comments and " +
        BASELINE +
        " allows {{allowed}}. Delete this one: make the code say it, " +
        "file an issue for a hack, or record a decision in docs/adr/ (see .claude/skills/delete-comment/SKILL.md). Never raise the baseline.",
      stale:
        "{{path}} has {{actual}} comments but " +
        BASELINE +
        " allows {{allowed}}. Lower its entry to {{actual}} " +
        "(`node scripts/comments.mjs --write-baseline`), so the baseline only shrinks.",
    },
  },
  create(context) {
    const path = relative(ROOT, context.filename);
    const allowed = allowedComments[path] ?? 0;
    return {
      "Program:exit"(program) {
        const comments = context.sourceCode
          .getAllComments()
          .filter((comment) => counts(comment, context.sourceCode.text));
        const data = { path, actual: comments.length, allowed };
        if (comments.length > allowed)
          for (const comment of comments)
            context.report({ loc: comment.loc, messageId: "comment", data });
        else if (comments.length < allowed)
          context.report({ node: program, messageId: "stale", data });
      },
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
    "no-double-assertion": noDoubleAssertion,
    "no-brand-cast": noBrandCast,
    "use-iso-time": useIsoTime,
    "no-comments": noComments,
  },
};
