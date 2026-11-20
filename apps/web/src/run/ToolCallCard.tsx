import { useState } from "react";
import { Badge, Code, Collapse, Group, Loader, Paper, Stack, Text, ThemeIcon, UnstyledButton } from "@mantine/core";
import { IconCheck, IconChevronDown, IconChevronRight, IconX } from "@tabler/icons-react";
import type { ToolCallEvent } from "./state";
import { TOOL_KINDS } from "./toolKinds";

const UI_OUTPUT_LIMIT = 3_000;

function StatusIcon({ status }: { status: ToolCallEvent["status"] }) {
  if (status === "started") return <Loader size={14} />;
  if (status === "completed") return <IconCheck size={16} color="var(--mantine-color-green-6)" />;
  return <IconX size={16} color="var(--mantine-color-red-6)" />;
}

export function ToolCallCard({ call }: { call: ToolCallEvent }) {
  const [open, setOpen] = useState(false);
  const kind = TOOL_KINDS[call.tool];
  const KindIcon = kind.icon;
  // Shell commands and file edits are what we mostly compare, so they stand out.
  const highlighted = call.tool === "shell" || call.tool === "file_edit";
  const output = call.output?.trim();

  return (
    <Paper
      withBorder
      radius="sm"
      p="xs"
      style={highlighted ? { borderLeft: `3px solid var(--mantine-color-${kind.color}-6)` } : undefined}
    >
      <Stack gap={6}>
        <UnstyledButton onClick={() => setOpen((o) => !o)} disabled={!output} style={{ cursor: output ? "pointer" : "default" }}>
          <Group gap="xs" wrap="nowrap">
            <ThemeIcon size="sm" variant="light" color={kind.color}>
              <KindIcon size={14} />
            </ThemeIcon>
            <Text size="sm" ff="monospace" truncate="end" style={{ flex: 1, minWidth: 0 }} title={call.title}>
              {call.title || kind.label}
            </Text>
            <StatusIcon status={call.status} />
            {output ? open ? <IconChevronDown size={14} /> : <IconChevronRight size={14} /> : null}
          </Group>
        </UnstyledButton>

        {call.files && call.files.length > 0 && (
          <Group gap={4}>
            {call.files.map((f) => (
              <Badge key={f} size="xs" variant="light" color={kind.color} tt="none">
                {f}
              </Badge>
            ))}
          </Group>
        )}

        {output && (
          <Collapse expanded={open}>
            <Code block style={{ maxHeight: 240, overflow: "auto", fontSize: 12 }}>
              {output.length > UI_OUTPUT_LIMIT ? `${output.slice(0, UI_OUTPUT_LIMIT)}\n…` : output}
            </Code>
          </Collapse>
        )}
      </Stack>
    </Paper>
  );
}
