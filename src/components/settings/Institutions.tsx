import { ArrowUpRight, Check, CornerDownLeft, LoaderCircle, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { parseSchoolHost, type Result, type SchoolHost } from "~/domain/ids";
import type { School } from "~/domain/lms";
import { cn } from "~/lib/utils";
import type { Secret } from "~/providers/provider";
import { hasChanges, useWorkspace, workspaceStore, type ConnectStage } from "~/stores/workspace";

import { SchoolStar } from "../Brand";
import { TokenSteps } from "../TokenForm";
import { STAGE_WORDS, STATUS_VIEW, connectionStatus, courseWords } from "./connection.logic";
import { placeRows, readDraftHosts } from "./drafts.logic";
import { RemoveSchoolDialog } from "./RemoveSchoolDialog";
import { SecretForm } from "./SecretForm";

/** A school the person has added, or an address typed here and not connected yet. */
export interface InstitutionRow {
  /** Stays put when a typed row's address is edited or its school connects, so the row keeps its fields and focus. */
  key: string;
  host: SchoolHost;
  school: School | null;
}

const demoToken = () => `demo-${crypto.randomUUID()}`;

/** Where the add form has no row for a saved school, its card above is where it connects, so focus goes there. */
const pointToCard = (school: School): string => {
  const state = workspaceStore().getState();
  const status = connectionStatus(state.connections[school.id], Boolean(state.syncing[school.id]));
  if (!STATUS_VIEW[status].needsToken) return `${school.name} is already connected above.`;
  document
    .querySelector<HTMLElement>(
      `[data-school="${school.id}"] :is([data-action="connect"], [data-action="reconnect"])`,
    )
    ?.focus();
  return `${school.name} is already here. Connect it above.`;
};

/**
 * The rows the add form shows. With `includeSaved`, every added school leads, which onboarding wants and Settings
 * doesn't, because Settings already shows each one as a card. Demo tokens go straight into the mounted field, or wait
 * in a ref until it mounts, so a filled token never sits in React state.
 * With `draftsKey`, typed addresses outlive the page in this tab's sessionStorage, so Back, Forward and reload keep them.
 * Their tokens are never kept: a token is stored only encrypted in the vault, after it connects.
 */
export function useInstitutions({
  includeSaved,
  draftsKey,
}: {
  includeSaved: boolean;
  draftsKey?: string;
}) {
  const schools = useWorkspace((state) => state.schools);
  const [typed, setTyped] = useState<readonly { key: string; host: SchoolHost }[]>(() =>
    draftsKey
      ? readDraftHosts(sessionStorage.getItem(draftsKey)).map((host) => ({
          key: crypto.randomUUID(),
          host,
        }))
      : [],
  );
  useEffect(() => {
    if (draftsKey) sessionStorage.setItem(draftsKey, JSON.stringify(typed.map(({ host }) => host)));
  }, [draftsKey, typed]);
  const fields = useRef(new Map<SchoolHost, HTMLInputElement>());
  const pending = useRef(new Map<SchoolHost, string>());
  const refs = useRef(new Map<SchoolHost, (element: HTMLInputElement | null) => void>());
  const justAdded = useRef<SchoolHost | null>(null);
  // A typed row hands its key to the school it connected, so onboarding keeps the same row mounted.
  const [connectedKeys, setConnectedKeys] = useState<ReadonlyMap<SchoolHost, string>>(new Map());

  const added = (host: SchoolHost) => schools.find((school) => school.host === host) ?? null;
  const taken = (host: SchoolHost) => added(host) || typed.some((draft) => draft.host === host);
  const drafts = typed.filter((draft) => !added(draft.host));
  const listed: readonly InstitutionRow[] = [
    ...(includeSaved
      ? schools.map((school) => ({
          key:
            typed.find((draft) => draft.host === school.host)?.key ??
            connectedKeys.get(school.host) ??
            school.host,
          host: school.host,
          school,
        }))
      : []),
    ...drafts.map(({ key, host }) => ({ key, host, school: null })),
  ];
  // A row keeps the place it first took, so a school that connects mid-setup doesn't jump above the rows still waiting.
  const [placed, setPlaced] = useState<readonly string[]>([]);
  const unplaced = listed.filter((row) => !placed.includes(row.key));
  if (unplaced.length > 0) setPlaced([...placed, ...unplaced.map((row) => row.key)]);
  const rows = placeRows(listed, placed);

  const tokenRef = (host: SchoolHost) => {
    const existing = refs.current.get(host);
    if (existing) return existing;
    const attach = (element: HTMLInputElement | null) => {
      if (!element) return void fields.current.delete(host);
      fields.current.set(host, element);
      const value = pending.current.get(host);
      pending.current.delete(host);
      if (value !== undefined) element.value = value;
      if (justAdded.current === host) {
        justAdded.current = null;
        element.focus();
      }
    };
    refs.current.set(host, attach);
    return attach;
  };

  /** Answers with a message for the address field, or null once the row is there. */
  const addAddress = (raw: string): string | null => {
    const parsed = parseSchoolHost(raw);
    if (!parsed.ok) return parsed.error;
    const saved = added(parsed.value);
    if (saved && !includeSaved) return pointToCard(saved);
    if (taken(parsed.value)) {
      fields.current.get(parsed.value)?.focus();
      return "That school is already added.";
    }
    justAdded.current = parsed.value;
    setTyped((all) => [...all, { key: crypto.randomUUID(), host: parsed.value }]);
    return null;
  };

  /** Moves a typed row to another address. The row stays mounted, so a pasted token stays in its field. */
  const editAddress = (row: InstitutionRow, raw: string): Result<SchoolHost, string> => {
    const parsed = parseSchoolHost(raw);
    if (!parsed.ok || parsed.value === row.host) return parsed;
    if (taken(parsed.value)) return { ok: false, error: "That school is already added." };
    setTyped((all) =>
      all.map((draft) => (draft.key === row.key ? { ...draft, host: parsed.value } : draft)),
    );
    return parsed;
  };

  /** A typed row is done once its school is saved, so removing that school later doesn't bring the row back. */
  const connected = (row: InstitutionRow) => {
    setConnectedKeys((keys) => new Map(keys).set(row.host, row.key));
    setTyped((all) => all.filter((draft) => draft.key !== row.key));
  };

  const remove = (row: InstitutionRow) => {
    setTyped((all) => all.filter((draft) => draft.host !== row.host));
    if (row.school) void workspaceStore().getState().removeSchool(row.school.id);
  };

  const fillDemo = () => {
    const { demoHosts, connections } = workspaceStore().getState();
    const waiting = demoHosts().filter((host) => {
      const school = added(host);
      return !school || connections[school.id]?.status !== "connected";
    });
    for (const host of waiting) {
      const field = fields.current.get(host);
      if (field) field.value = demoToken();
      else pending.current.set(host, demoToken());
    }
    setTyped((all) => [
      ...all,
      ...waiting
        .filter((host) => !added(host) && !all.some((draft) => draft.host === host))
        .map((host) => ({ key: crypto.randomUUID(), host })),
    ]);
  };

  return { rows, tokenRef, addAddress, editAddress, connected, remove, fillDemo };
}
export type Institutions = ReturnType<typeof useInstitutions>;

export function AddressField({
  institutions,
  placeholder,
  autoFocus,
}: {
  institutions: Institutions;
  placeholder: string;
  autoFocus?: boolean;
}) {
  const [draft, setDraft] = useState("");
  const [said, setSaid] = useState<{ text: string; over: string } | null>(null);
  // A message speaks to the list it was said over, so a row added or removed another way retires it.
  const over = institutions.rows.map((row) => row.key).join();
  const error = said?.over === over ? said.text : null;
  const setError = (text: string | null) => setSaid(text === null ? null : { text, over });
  const add = () => {
    const problem = institutions.addAddress(draft);
    setError(problem);
    if (!problem) setDraft("");
  };
  return (
    <div className="flex flex-col gap-1.5">
      <div className="relative">
        <input
          data-testid="address-field"
          aria-label="School address"
          autoComplete="off"
          spellCheck={false}
          autoFocus={autoFocus}
          className="h-btn-lg w-full rounded-control border border-input bg-background pr-10 pl-field-x text-body text-foreground outline-none placeholder:text-tertiary-label focus-visible:ring-2 focus-visible:ring-ring"
          placeholder={placeholder}
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
            setError(null);
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            add();
          }}
        />
        <button
          type="button"
          aria-label="Add address"
          onClick={add}
          className="absolute top-1/2 right-1.5 flex size-btn-sm -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <CornerDownLeft className="size-3.5" />
        </button>
      </div>
      {error && (
        <p role="alert" className="text-meta text-error-foreground">
          {error}
        </p>
      )}
    </div>
  );
}

function ConnectedLine({ school }: { school: School }) {
  const record = useWorkspace((state) => state.connections[school.id]);
  const syncing = useWorkspace((state) => Boolean(state.syncing[school.id]));
  const courses = useWorkspace((state) => state.cache[school.id]?.courses.length ?? 0);
  if (syncing && courses === 0)
    return (
      <span
        role="status"
        data-testid="connect-stage"
        className="flex items-center gap-1.5 text-meta text-muted-foreground"
      >
        <LoaderCircle className="size-3 animate-spin" />
        {STAGE_WORDS.reading}
      </span>
    );
  return (
    <span className="flex items-center gap-1.5 text-meta text-success-foreground">
      <Check className="size-3" />
      Connected as {record?.accountName}, {courseWords(courses).replace(" found", "")}
    </span>
  );
}

export function Dot({ school }: { school: School | null }) {
  return school ? (
    <SchoolStar school={school.id} />
  ) : (
    <span aria-hidden className="size-3 flex-none rounded-full border border-muted-foreground/50" />
  );
}

/** A typed row's address, editable until the school connects and locked while it tries. Enter or leaving the field moves the row; Escape undoes. */
function RowAddress({
  row,
  institutions,
  locked,
  onError,
}: {
  row: InstitutionRow;
  institutions: Institutions;
  locked: boolean;
  onError: (error: string | null) => void;
}) {
  const [address, setAddress] = useState<string>(row.host);
  const commit = () => {
    const result = institutions.editAddress(row, address);
    if (result.ok) setAddress(result.value);
    onError(result.ok ? null : result.error);
  };
  return (
    <input
      data-testid="row-address"
      aria-label={`Address for ${row.host}`}
      autoComplete="off"
      spellCheck={false}
      className="-my-1 h-btn-sm min-w-0 flex-1 rounded-control border border-input bg-background px-1.5 text-body text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
      value={address}
      readOnly={locked}
      onChange={(event) => {
        setAddress(event.target.value);
        onError(null);
      }}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          commit();
        } else if (event.key === "Escape") {
          setAddress(row.host);
          onError(null);
        }
      }}
    />
  );
}

function InstitutionRowView({
  row,
  institutions,
}: {
  row: InstitutionRow;
  institutions: Institutions;
}) {
  const status = useWorkspace((state) =>
    row.school
      ? connectionStatus(state.connections[row.school.id], Boolean(state.syncing[row.school.id]))
      : null,
  );
  const connected = status !== null && !STATUS_VIEW[status].needsToken;
  const enrollment = useWorkspace((state) =>
    row.school ? state.enrollmentFor(row.school.id) : state.newSchoolEnrollment(),
  );
  const removable = useWorkspace((state) => !row.school || !hasChanges(state, row.school.id));
  const [stage, setStage] = useState<ConnectStage | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [addressError, setAddressError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const item = useRef<HTMLLIElement>(null);
  // The row holds the height it had when Connect was pressed, so the rows and choices below stay under the pointer.
  const [held, setHeld] = useState<number>();

  const connect = async (secret: Secret): Promise<string | null> => {
    const store = workspaceStore().getState();
    setHeld(item.current?.offsetHeight);
    setConnecting(true);
    const result = row.school
      ? await store.connect(row.school.id, secret, setStage)
      : await store.addSchool(row.host, secret, setStage);
    setStage(null);
    setConnecting(false);
    if (result.ok && !row.school) institutions.connected(row);
    return result.ok ? null : result.error;
  };

  return (
    <li
      ref={item}
      style={{ minHeight: held }}
      data-host={row.host}
      data-connection={status ?? "new"}
      className="flex flex-col gap-2 px-card py-3"
    >
      <div className="flex min-w-0 items-center gap-2">
        <Dot school={connected ? row.school : null} />
        {row.school ? (
          <span className="truncate text-body">{row.host}</span>
        ) : (
          <RowAddress
            row={row}
            institutions={institutions}
            locked={connecting}
            onError={setAddressError}
          />
        )}
        {connected && row.school && (
          <span className="truncate text-meta text-muted-foreground">{row.school.name}</span>
        )}
        {removable && (
          <button
            type="button"
            aria-label={`Remove ${row.host}`}
            className="-my-1 ml-auto flex size-btn-sm flex-none items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
            onClick={() => (connected ? setConfirming(true) : institutions.remove(row))}
          >
            <X className="size-3.5" />
          </button>
        )}
        {connected && row.school && (
          <RemoveSchoolDialog
            school={row.school}
            open={confirming}
            onOpenChange={setConfirming}
            onConfirm={async () => institutions.remove(row)}
          />
        )}
      </div>
      {addressError && (
        <p role="alert" className="pl-5 text-meta text-error-foreground">
          {addressError}
        </p>
      )}
      <div className="pl-5">
        {connected && row.school ? (
          <ConnectedLine school={row.school} />
        ) : enrollment?.kind === "paste-token" ? (
          <SecretForm
            layout="inline"
            fieldLabel={enrollment.fieldLabel}
            submitLabel="Connect"
            busyLabel="Connecting"
            onSubmit={connect}
            context={addressError ?? row.host}
            inputRef={institutions.tokenRef(row.host)}
            lands='[data-host]:not([data-connection="connected"]) input[type="password"]'

            aside={
              <a
                href={enrollment.tokenPageUrl(row.host)}
                target="_blank"
                rel="noreferrer"
                className="link flex flex-none items-center gap-1 whitespace-nowrap text-meta"
              >
                Get a token <ArrowUpRight className="size-3" />
              </a>
            }
            progress={
              <p
                role="status"
                data-testid="connect-stage"
                className="flex flex-none items-center gap-1.5 text-meta whitespace-nowrap text-muted-foreground"
              >
                <LoaderCircle className="size-3 animate-spin" />
                {stage ? STAGE_WORDS[stage] : "Starting"}
              </p>
            }
          >
            <TokenSteps steps={enrollment.steps} />
          </SecretForm>
        ) : (
          <p className="text-meta text-muted-foreground">
            This school signs in on its own page, which isn't available in this build.
          </p>
        )}
      </div>
    </li>
  );
}

export function InstitutionList({
  institutions,
  className,
}: {
  institutions: Institutions;
  className?: string;
}) {
  if (institutions.rows.length === 0) return null;
  return (
    <ul
      data-testid="institution-rows"
      className={cn(
        "flex flex-col divide-y divide-border rounded-xl border border-border bg-card",
        className,
      )}
    >
      {institutions.rows.map((row) => (
        <InstitutionRowView key={row.key} row={row} institutions={institutions} />
      ))}
    </ul>
  );
}
