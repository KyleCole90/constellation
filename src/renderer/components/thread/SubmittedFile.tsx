import { Suspense, use, useEffect, useRef, useState } from "react";

import { errorWords } from "~/shared/domain/change";
import {
  fileLabel,
  viewOf,
  type FileContent,
  type FileView,
  type Submission,
  type SubmissionFile,
} from "~/shared/domain/lms";
import { useWorkspace, workspaceStore } from "~/renderer/stores/workspace";
import type { Read } from "~/shared/providers/provider";

const MAX_PAGES = 30;
const RECENT_READS = 8;
const reads = new Map<string, Read<FileContent>>();

const keyOf = (submission: Submission, id: string) => `${submission.ref}\n${id}`;

const readOf = (submission: Submission, id: string): Read<FileContent> => {
  const key = keyOf(submission, id);
  const kept = reads.get(key);
  if (kept) return kept;
  const read = workspaceStore().getState().readFile(submission, id);
  reads.set(key, read);
  for (const old of reads.keys()) if (reads.size > RECENT_READS) reads.delete(old);
  return read;
};

const dataUrl = (mediaType: string, { data }: FileContent): string => {
  let binary = "";
  for (let at = 0; at < data.length; at += 0x8000)
    binary += String.fromCharCode(...data.subarray(at, at + 0x8000));
  return `data:${mediaType};base64,${btoa(binary)}`;
};

/** pdf.js runs without WebAssembly: a CSP without `'wasm-unsafe-eval'` blocks compiling it. */
function PdfPages({ file, name }: { file: FileContent; name: string }) {
  const root = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<{ pages: number; failed: boolean }>({
    pages: 0,
    failed: false,
  });
  useEffect(() => {
    const holder = root.current;
    if (!holder) return;
    const stop = new AbortController();
    const loading = (async () => {
      const pdfjs = await import("pdfjs-dist");
      const worker = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
      pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
      // pdf.js may move the buffer into its worker, so it gets a copy.
      return pdfjs.getDocument({ data: file.data.slice(), useWasm: false, enableXfa: false });
    })();
    const draw = async () => {
      const pdf = await (await loading).promise;
      const width = holder.clientWidth || 560;
      const count = Math.min(pdf.numPages, MAX_PAGES);
      for (let number = 1; number <= count; number++) {
        if (stop.signal.aborted) return;
        const page = await pdf.getPage(number);
        const unit = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: (width / unit.width) * devicePixelRatio });
        const canvas = document.createElement("canvas");
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        canvas.dataset["pdfPage"] = String(number);
        canvas.setAttribute("aria-label", `${name}, page ${number}`);
        canvas.className = "w-full rounded-md border border-border bg-white";
        holder.append(canvas);
        await page.render({ canvas, viewport }).promise;
      }
      if (!stop.signal.aborted) setState({ pages: pdf.numPages, failed: false });
    };
    draw().catch(() => {
      if (!stop.signal.aborted) setState({ pages: 0, failed: true });
    });
    return () => {
      stop.abort();
      void loading.then(
        (task) => task.destroy(),
        () => undefined,
      );
      holder.replaceChildren();
    };
  }, [file, name]);
  return (
    <>
      <div ref={root} data-pdf className="flex flex-col gap-2" />
      {state.failed && (
        <p className="text-meta text-muted-foreground">This PDF couldn't be drawn here.</p>
      )}
      {state.pages > MAX_PAGES && (
        <p className="text-meta text-muted-foreground">
          Showing the first {MAX_PAGES} of {state.pages} pages.
        </p>
      )}
    </>
  );
}

const HEADINGS = ["h2", "h3", "h4", "h5", "h6", "h6"] as const;

function TextBlock({ block }: { block: string }) {
  const heading = /^(#{1,6}) (.*)$/s.exec(block);
  if (!heading) return <p className="whitespace-pre-wrap">{block}</p>;
  const level = heading[1]?.length ?? 1;
  const Tag = HEADINGS[level - 1] ?? "h6";
  return (
    <Tag
      className={level <= 2 ? "mt-4 mb-2 text-page first:mt-0" : "mt-3 mb-1 text-title first:mt-0"}
    >
      {heading[2]}
    </Tag>
  );
}

/** The words main read out of a Word, RTF or text file, as Markdown, drawn as React text and never as markup. */
function TextPages({ file }: { file: FileContent }) {
  const blocks = new TextDecoder().decode(file.data).split(/\n{2,}/);
  return (
    <div data-text className="paper">
      {blocks.map((block, index) => (
        // oxlint-disable-next-line react/no-array-index-key -- blocks split from one string have no id and can repeat
        <TextBlock key={index} block={block} />
      ))}
    </div>
  );
}

const isText = (mediaType: string) => mediaType === "text/markdown" || mediaType === "text/plain";

/** A refusal from main is final for that file, so it stays cached; any other failure is tried again next time. */
const forgetIfRetryable = (key: string, read: Awaited<Read<FileContent>>) => {
  if (!read.ok && read.error.kind !== "rejected") reads.delete(key);
};

function Preview({
  submission,
  file,
  kind,
  vendor,
}: {
  submission: Submission;
  file: SubmissionFile;
  kind: FileView;
  vendor: string;
}) {
  const read = use(readOf(submission, file.id));
  const key = keyOf(submission, file.id);
  useEffect(() => () => forgetIfRetryable(key, read), [read, key]);
  if (!read.ok)
    return (
      <p data-file-failed className="text-body text-muted-foreground">
        {read.error.kind === "rejected"
          ? `${read.error.reason}${submission.page ? ` Open it in ${vendor}.` : ""}`
          : `The app couldn't load this file. ${errorWords(read.error)}`}
      </p>
    );
  switch (kind) {
    case "image":
      return (
        <img
          src={dataUrl(file.mediaType, read.value)}
          alt={file.name}
          className="max-w-full rounded-md border border-border"
        />
      );
    case "document":
      return <PdfPages file={read.value} name={file.name} />;
    case "text":
      return isText(read.value.mediaType) ? (
        <TextPages file={read.value} />
      ) : (
        <p data-file-failed className="text-body text-muted-foreground">
          Couldn't read this file.{submission.page ? ` Open it in ${vendor}.` : ""}
        </p>
      );
  }
}

/**
 * Why Claude can't draft this upload when main refused one of its files, such as a damaged Word file, or null. The
 * pane reads the same files, so this costs no extra download.
 */
export function useRefusedFile(submission: Submission | null): string | null {
  const [refused, setRefused] = useState<Readonly<Record<string, string | null>>>({});
  useEffect(() => {
    const body = submission?.body;
    if (!submission || body?.kind !== "upload") return;
    void (async () => {
      let why: string | null = null;
      for (const file of body.files) {
        if (viewOf(file) === null) continue;
        const read = await readOf(submission, file.id);
        if (!read.ok && read.error.kind === "rejected") {
          why = `${file.name}: ${read.error.reason} Claude can't draft it. Grade it yourself.`;
          break;
        }
      }
      setRefused((known) =>
        known[submission.ref] === why ? known : { ...known, [submission.ref]: why },
      );
    })();
  }, [submission]);
  return submission ? (refused[submission.ref] ?? null) : null;
}

export function SubmittedFile({
  submission,
  file,
}: {
  submission: Submission;
  file: SubmissionFile;
}) {
  const kind = viewOf(file);
  const vendor = useWorkspace((state) => state.vendorLabelFor(submission.school) ?? "the LMS");
  return (
    <figure data-file={file.name} className="flex flex-col gap-1.5">
      <figcaption className="flex flex-wrap items-baseline gap-x-2 text-meta">
        <span className="font-medium break-all text-foreground">{file.name}</span>
        <span className="text-muted-foreground">{fileLabel(file)}</span>
        {submission.page && (
          <a href={submission.page} target="_blank" rel="noreferrer" className="link">
            Open in {vendor}
          </a>
        )}
      </figcaption>
      {kind === null ? (
        <p className="text-body text-muted-foreground">
          This kind of file doesn't open in the app.
          {submission.page ? ` Open it in ${vendor} to read it.` : ""}
        </p>
      ) : (
        <Suspense fallback={<p className="text-meta text-muted-foreground">Loading {file.name}</p>}>
          <Preview submission={submission} file={file} kind={kind} vendor={vendor} />
        </Suspense>
      )}
    </figure>
  );
}
