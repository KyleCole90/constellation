import { useEffect, useState, type ChangeEvent } from "react";

import type { CopySource, SamplePackage, SourceCourse } from "~/shared/domain/content";
import type { CourseSetup } from "~/shared/domain/setup";
import { useWorkspace, workspaceStore } from "~/renderer/stores/workspace";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card, Note, Refusal } from "./parts";
import { sourceChoices } from "./setup.logic";

function CourseChoice({ source, onChoose }: { source: SourceCourse; onChoose: () => void }) {
  return (
    <li data-row={source.ref}>
      <button
        type="button"
        data-testid={`source-course-${source.code}`}
        data-term={source.termName}
        onClick={onChoose}
        className="flex min-h-row-table w-full cursor-pointer items-center gap-2 rounded-control border border-border pr-row-end pl-row-x text-left outline-none hover:bg-accent focus-visible:border-ring"
      >
        <span className="flex-none text-meta font-medium">{source.code}</span>
        <span className="min-w-0 flex-1 truncate text-body">{source.title}</span>
        {source.template && <Badge tone="info">Template</Badge>}
        <span className="flex-none text-meta text-muted-foreground">{source.termName}</span>
      </button>
    </li>
  );
}

function SampleChoice({
  sample,
  index,
  onChoose,
}: {
  sample: SamplePackage;
  index: number;
  onChoose: () => void;
}) {
  return (
    <li data-row={sample.name}>
      <button
        type="button"
        data-testid={`source-sample-${index}`}
        onClick={onChoose}
        className="flex min-h-row-two w-full cursor-pointer flex-col rounded-control border border-border py-row-y pr-row-end pl-row-x text-left outline-none hover:bg-accent focus-visible:border-ring"
      >
        <span className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-body">{sample.name}</span>
          <span className="flex-none rounded bg-foreground/7 px-pill-x py-pill-y text-meta text-secondary-label">
            Sample
          </span>
          <span className="flex-none text-meta text-muted-foreground">{sample.kb} KB</span>
        </span>
        <span className="text-meta text-muted-foreground">{sample.note}</span>
      </button>
    </li>
  );
}

export function SourceCard({ setup }: { setup: CourseSetup }) {
  const { course, school } = setup;
  const options = useWorkspace((state) => state.setupOptions[school]);
  const vendor = useWorkspace((state) => state.vendorLabelFor(school) ?? "LMS");
  const picker = useWorkspace((state) => state.picksPackage(school));
  const [loading, setLoading] = useState(true);
  const [refused, setRefused] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void workspaceStore()
      .getState()
      .loadSetupOptions(school)
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [school]);

  const choose = (source: CopySource) =>
    setRefused(workspaceStore().getState().chooseSource(course, source));
  const onFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // Cleared so picking the same file again after a refusal still fires a change.
    event.target.value = "";
    if (file)
      setRefused(
        workspaceStore()
          .getState()
          .chooseCartridgeFile(course, { name: file.name, size: file.size }),
      );
  };
  const choices = sourceChoices(options?.sources ?? [], course, setup.shell.code);
  const samples = options?.samples ?? [];

  return (
    <Card title={`Where should ${setup.shell.code} come from?`} testId="source-card">
      <section className="flex flex-col gap-2">
        <h4 className="text-title text-foreground">A previous {vendor} course</h4>
        {choices.length > 0 ? (
          <ul className="flex flex-col gap-1">
            {choices.map((source) => (
              <CourseChoice
                key={source.ref}
                source={source}
                onChoose={() =>
                  choose({
                    kind: "course",
                    ref: source.ref,
                    label: `${source.code} ${source.title}`,
                    termName: source.termName,
                  })
                }
              />
            ))}
          </ul>
        ) : (
          <Note>{loading ? "Reading your courses." : "No previous courses to copy from."}</Note>
        )}
      </section>
      <section className="flex flex-col gap-2">
        <h4 className="text-title text-foreground">Upload a Common Cartridge file (.imscc)</h4>
        {picker ? (
          <Button
            variant="outline"
            size="sm"
            className="self-start"
            data-testid="cartridge-pick"
            onClick={() => void workspaceStore().getState().pickCartridge(course).then(setRefused)}
          >
            Choose a .imscc file
          </Button>
        ) : (
          <input
            type="file"
            accept=".imscc"
            data-testid="cartridge-input"
            aria-label="Upload a Common Cartridge file"
            onChange={onFile}
            className="text-meta text-muted-foreground file:mr-2 file:h-7 file:cursor-pointer file:rounded-control file:border file:border-input file:bg-transparent file:px-2 file:text-meta file:text-foreground"
          />
        )}
        {refused ? (
          <Refusal text={refused} />
        ) : (
          <Note>Course exports are .imscc files, not CSV.</Note>
        )}
        {samples.length > 0 && (
          <ul className="flex flex-col gap-1">
            {samples.map((sample, index) => (
              <SampleChoice
                key={sample.name}
                sample={sample}
                index={index}
                onChoose={() =>
                  choose({ kind: "cartridge", name: sample.name, kb: sample.kb, hint: sample.hint })
                }
              />
            ))}
          </ul>
        )}
      </section>
      {!loading && !options && (
        <Button
          variant="outline"
          size="sm"
          className="self-start"
          onClick={() => void workspaceStore().getState().loadSetupOptions(school)}
        >
          Try reading again
        </Button>
      )}
    </Card>
  );
}
