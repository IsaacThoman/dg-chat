import { useContext, useState } from "react";
import { RiEqualizer2Line } from "@remixicon/react";

import { ChatSessionActivityContext } from "../chatSessionActivity.ts";
import { Badge } from "../components/ui/badge.tsx";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
} from "../components/ui/select.tsx";
import type { Model } from "../types.ts";

export function ModelPicker({
  models,
  selected,
  setSelected,
}: {
  models: Model[];
  selected: string;
  setSelected: (id: string) => void;
}) {
  const sessionActive = useContext(ChatSessionActivityContext);
  const [open, setOpen] = useState(false);
  const model = models.find((item) => item.id === selected) ?? models[0];

  return (
    <div className="model-picker">
      <Select
        value={model?.id ?? null}
        open={sessionActive && open}
        onOpenChange={setOpen}
        onValueChange={(value) => value && setSelected(value)}
        disabled={!models.length}
      >
        <SelectTrigger className="model-trigger" aria-label="Chat model">
          <span className="model-glyph" aria-hidden="true">
            {model?.provider[0]?.toUpperCase() ?? "–"}
          </span>
          <span className="model-trigger-copy">
            <strong>{model?.name ?? "No chat model"}</strong>
            {model && <small>{model.provider} · {model.context}</small>}
          </span>
        </SelectTrigger>
        <SelectContent
          className="model-popover"
          align="start"
          alignItemWithTrigger={false}
          listProps={{ "aria-label": "Chat model" }}
        >
          <SelectGroup>
            <SelectLabel className="popover-title">
              Choose a model <RiEqualizer2Line aria-hidden="true" />
            </SelectLabel>
            {models.map((item) => (
              <SelectItem key={item.id} value={item.id} className="model-option">
                <span className={`health-dot ${item.healthy ? "" : "down"}`} />
                <span className="model-option-copy">
                  <strong>{item.name}</strong>
                  <small>{item.provider} · {item.context} context</small>
                </span>
                <span className="capabilities" aria-label="Capabilities">
                  {item.capabilities.map((capability) => (
                    <Badge key={capability} variant="secondary">{capability}</Badge>
                  ))}
                </span>
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    </div>
  );
}
