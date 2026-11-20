import { ActionIcon, Textarea, type ElementProps, type TextareaProps } from "@mantine/core";
import { IconArrowUp } from "@tabler/icons-react";
import classes from "./PromptTextarea.module.css";

export interface PromptTextareaProps
  extends
    Omit<TextareaProps, "value" | "onChange">,
    ElementProps<"textarea", keyof TextareaProps | "value" | "onChange"> {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  sendLabel?: string;
  loading?: boolean;
}

/** A prompt box that sends on Enter (Shift+Enter for a new line) or through its send button. */
export function PromptTextarea({ value, onChange, onSubmit, sendLabel = "Send", loading, ...props }: PromptTextareaProps) {
  return (
    <Textarea
      size="md"
      autosize
      minRows={3}
      maxRows={12}
      classNames={{ input: classes.input }}
      value={value}
      onChange={(e) => onChange(e.currentTarget.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
          e.preventDefault();
          onSubmit();
        }
      }}
      rightSectionWidth={52}
      rightSectionProps={{ style: { alignItems: "flex-end", paddingBottom: 10 } }}
      rightSection={
        <ActionIcon size="lg" aria-label={sendLabel} onClick={onSubmit} loading={loading} disabled={!value.trim()}>
          <IconArrowUp size={18} />
        </ActionIcon>
      }
      {...props}
    />
  );
}
