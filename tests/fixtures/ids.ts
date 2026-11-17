/** Test mints for branded ids: the one test file where `constellation/no-brand-cast` allows a brand cast. */
import type {
  ChangeId,
  IsoDate,
  LmsRef,
  SchoolHost,
  SchoolId,
  ThreadId,
} from "../../src/shared/domain/ids";
import type { FindingKey } from "../../src/shared/domain/scan";

export const threadId = (text: string): ThreadId => text as ThreadId;
export const schoolId = (text: string): SchoolId => text as SchoolId;
export const changeId = (text: string): ChangeId => text as ChangeId;
export const isoDate = (text: string): IsoDate => text as IsoDate;
export const schoolHost = (text: string): SchoolHost => text as SchoolHost;
export const findingKey = (text: string): FindingKey => text as FindingKey;
export const lmsRef = <K extends string>(text: string): LmsRef<K> => text as LmsRef<K>;
