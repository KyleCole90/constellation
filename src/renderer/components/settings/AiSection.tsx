import { REAL_AI, SPEND_LIMITS_URL, VAULT_PLACE } from "~/renderer/desktop";
import { ArrowUpRight } from "lucide-react";
import { useState } from "react";

import type { AiSource } from "~/renderer/stores/types";
import { useAiOn, useWorkspace, workspaceStore } from "~/renderer/stores/workspace";

import { isMacDevice } from "../device";
import { Badge, type BadgeTone } from "../ui/badge";
import { Button } from "../ui/button";
import { Dialog, DialogDescription, DialogPopup, DialogTitle } from "../ui/dialog";
import { AiKeyForm } from "./AiKeyForm";
import { ConfirmDialog } from "./ConfirmDialog";
import { SettingsCard, SettingsRow, SettingsSection } from "./layout";

const SOURCE_VIEW: Readonly<Record<AiSource, { label: string; badge: BadgeTone; words: string }>> =
  {
    key: {
      label: "Anthropic key",
      badge: "success",
      words: `A key is saved in ${VAULT_PLACE}. It is never shown again.`,
    },
    "on-device": {
      label: "On-device model",
      badge: "success",
      words: "Drafts are set to come from the model built into macOS, so nothing leaves this Mac.",
    },
    none: {
      label: "Off",
      badge: "neutral",
      words: "No AI. You fill in grades and replies by hand.",
    },
  };

const CHATS_KEPT = "Your chats are kept and come back when AI is on.";

export function AiSection() {
  const source = useWorkspace((state) => state.aiSource);
  const ai = useAiOn();
  const hasChats = useWorkspace((state) =>
    Object.values(state.threads).some((thread) => thread.kind === "north-star-chat"),
  );
  const [entering, setEntering] = useState(false);
  const [turnOff, setTurnOff] = useState({ open: false, key: false });
  const mac = isMacDevice();
  const view = SOURCE_VIEW[source];
  const store = () => workspaceStore().getState();
  return (
    <SettingsSection
      title="AI"
      description={
        ai
          ? REAL_AI
            ? "AI is on. Drafts and chat come from Claude, billed to your Anthropic key. Each thread shows what it has cost."
            : "AI is on. Drafts come from built-in rules for now, because no model is wired up in this prototype."
          : `AI is off, so you fill in grades and replies by hand. ${REAL_AI ? "Add a key" : "Add a key or use the on-device model"} to turn on AI drafts and chat.${hasChats ? ` ${CHATS_KEPT}` : ""}`
      }
    >
      <SettingsCard data-testid="ai-card">
        <SettingsRow
          data-testid="ai-source-row"
          title={
            <>
              Drafts from
              <Badge tone={view.badge}>{view.label}</Badge>
            </>
          }
          description={view.words}
          control={
            <>
              <Button
                variant={source === "none" ? "default" : "outline"}
                onClick={() => setEntering(true)}
              >
                {source === "key" ? "Replace key" : "Use a key"}
              </Button>
              {!REAL_AI && source !== "on-device" && (
                <Button
                  disabled={!mac}
                  title={mac ? undefined : "Only on a Mac with Apple Intelligence."}
                  onClick={() => void store().chooseOnDeviceModel()}
                >
                  Use on-device model
                </Button>
              )}
              {source !== "none" && (
                <Button
                  variant="destructive-outline"
                  onClick={() => setTurnOff({ open: true, key: source === "key" })}
                >
                  {source === "key" ? "Remove key" : "Turn off AI"}
                </Button>
              )}
            </>
          }
        />
        {REAL_AI && (
          <SettingsRow
            data-testid="ai-spend-row"
            title="Spend limit"
            description="The app has no cap of its own. Set a monthly limit for your key in Anthropic's console."
            control={
              <a
                href={SPEND_LIMITS_URL}
                target="_blank"
                rel="noreferrer"
                className="link flex flex-none items-center gap-1 whitespace-nowrap text-meta"
              >
                Spend limits <ArrowUpRight className="size-3" />
              </a>
            }
          />
        )}
      </SettingsCard>
      {!REAL_AI && !mac && (
        <p className="text-meta text-muted-foreground">
          The on-device model is only on a Mac with Apple Intelligence.
        </p>
      )}
      <ConfirmDialog
        open={turnOff.open}
        onOpenChange={(open) => setTurnOff((state) => ({ ...state, open }))}
        title={turnOff.key ? "Remove the AI key?" : "Turn off AI?"}
        confirmLabel={turnOff.key ? "Remove key" : "Turn off AI"}
        onConfirm={() => store().turnOffAi()}
      >
        <p>
          {turnOff.key ? `This forgets the key in ${VAULT_PLACE}. ` : ""}North Star, chat, and AI
          drafts turn off, and you fill in grades and replies by hand.
        </p>
        <p>Drafts already written stay. {CHATS_KEPT}</p>
      </ConfirmDialog>
      <Dialog open={entering} onOpenChange={setEntering}>
        <DialogPopup>
          <DialogTitle>{source === "key" ? "Replace the AI key" : "Add an AI key"}</DialogTitle>
          <DialogDescription>
            The key goes in {VAULT_PLACE} and is never shown again. A saved key turns on AI drafts,
            {REAL_AI ? " which come from Claude." : " which come from built-in rules for now."}
          </DialogDescription>
          <AiKeyForm
            submitLabel={source === "key" ? "Replace key" : "Save key"}
            onSaved={() => setEntering(false)}
          />
        </DialogPopup>
      </Dialog>
    </SettingsSection>
  );
}
