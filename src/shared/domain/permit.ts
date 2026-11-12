import { fingerprintOf } from "./approval";
import type { ChangeContent, ChangeRecord, FieldKey } from "./change";
import type { ChangeId } from "./ids";

/**
 * What a provider's `apply` demands. Minted only here, only from a change in `sending` whose approval still
 * matches its content. Only writeback/ may import mintSendPermit, enforced by a structure test.
 */
export class SendPermit {
  // oxlint-disable-next-line eslint/no-unused-private-class-members -- read by the `#sealed in value` brand check, which the rule does not count
  readonly #sealed = true;
  readonly changeId: ChangeId;
  readonly content: ChangeContent;
  readonly fields: readonly FieldKey[];
  private constructor(changeId: ChangeId, content: ChangeContent, fields: readonly FieldKey[]) {
    this.changeId = changeId;
    this.content = content;
    this.fields = fields;
  }
  static isGenuine(value: unknown): value is SendPermit {
    return typeof value === "object" && value !== null && #sealed in value;
  }
  static mint(record: ChangeRecord, fields: readonly FieldKey[]): SendPermit | null {
    const { state } = record;
    if (state.tag !== "sending" || state.approval.fingerprint !== fingerprintOf(record))
      return null;
    return new SendPermit(record.id, record.content, fields);
  }
  /**
   * Main's copy of a permit the renderer minted, rebuilt from the plain data IPC carries. Main takes it as sent until
   * the writeback step checks it against its approval (docs/electron-spec.md, step 12). Only src/main calls this,
   * enforced by a structure test.
   */
  static relayed(
    changeId: ChangeId,
    content: ChangeContent,
    fields: readonly FieldKey[],
  ): SendPermit {
    return new SendPermit(changeId, content, fields);
  }
}
export const mintSendPermit = SendPermit.mint;
