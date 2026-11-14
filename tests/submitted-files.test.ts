import { describe, expect, it } from "vite-plus/test";

import type { Agent, AgentInput } from "~/shared/agent/agent";
import type { ThreadId } from "~/shared/domain/ids";

import { makeStoreRig } from "./fixtures/store-rig";

const QUEUE = "t-queue" as ThreadId;

const spy = () => {
  const asked: AgentInput[] = [];
  const agent: Agent = {
    async *run(input) {
      asked.push(input);
      yield { type: "say", text: "Read it." };
    },
  };
  return { agent, asked };
};

const rigWith = async (agent: Agent) => {
  const rig = await makeStoreRig({ agent });
  await rig.connectAll();
  const open = (student: string) => {
    const submission = rig.server.findSubmission(student, "Reading Response 5");
    if (!submission) throw new Error(`No submission for ${student}.`);
    return rig.clock.run(rig.state().openSubmission(QUEUE, submission, { fill: "draft" }));
  };
  return { rig, open };
};

describe("drafting from a submitted file", () => {
  it("hands Claude the PDF the student uploaded", async () => {
    const { agent, asked } = spy();
    const { open } = await rigWith(agent);
    await open("Maya Ortiz");
    const [input] = asked;
    expect(input?.files?.map((file) => [file.name, file.mediaType])).toEqual([
      ["Reading Response 5.pdf", "application/pdf"],
    ]);
    expect(new TextDecoder().decode(input?.files?.[0]?.data.slice(0, 8))).toBe("%PDF-1.4");
  });

  it("opens work Claude can't read for the teacher to grade, without asking Claude", async () => {
    const { agent, asked } = spy();
    const { open } = await rigWith(agent);
    await open("Aaliyah Brooks");
    await open("Priya Raman");
    expect(asked).toEqual([]);
  });

  it("hands Claude a text upload, as the file came back", async () => {
    const { agent, asked } = spy();
    const { open } = await rigWith(agent);
    await open("Jonah Feld");
    const [input] = asked;
    expect(input?.files?.map((file) => [file.name, file.mediaType])).toEqual([
      ["response5.txt", "text/plain"],
    ]);
    expect(new TextDecoder().decode(input?.files?.[0]?.data)).toContain("depends on the subject");
  });

  it("drafts nothing when the file doesn't download, and says so", async () => {
    const { agent, asked } = spy();
    const { rig, open } = await rigWith(agent);
    rig.server.setNoise({ rate5xx: 1 });
    await open("Maya Ortiz");
    expect(asked).toEqual([]);
    const said = JSON.stringify(rig.state().threads[QUEUE]?.messages ?? []);
    expect(said).toContain("couldn't download Reading Response 5.pdf");
    expect(said).toContain("nothing was drafted");
  });
});
