import { useEffect, useState } from "react";
import { Alert, Badge, Collapse, Group, Paper, Stack, Text, Title, UnstyledButton } from "@mantine/core";
import { IconAlertTriangle, IconBrain } from "@tabler/icons-react";
import type { TimelineItem, Turn } from "./state";
import { isFinished } from "./state";
import { formatDuration } from "../lib/format";
import { ToolCallCard } from "./ToolCallCard";
import { FilesPanel } from "./FilesPanel";

// No badge while running (the line above the cards shows that) or when done (the timer says so).
const STATUS_COLORS: Partial<Record<Turn["status"], string>> = {
  failed: "red",
  cancelled: "yellow",
};

function useElapsed(turn: Turn | undefined): number | undefined {
  const [now, setNow] = useState(Date.now());
  const running = turn?.status === "running";
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  if (turn?.startedAt === undefined) return undefined;
  return (turn.endedAt ?? Math.max(now, turn.startedAt)) - turn.startedAt;
}

function Reasoning({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <UnstyledButton onClick={() => setOpen((o) => !o)}>
        <Group gap={4}>
          <IconBrain size={14} color="var(--mantine-color-dimmed)" />
          <Text size="xs" c="dimmed">
            {open ? "Hide reasoning" : "Reasoning…"}
          </Text>
        </Group>
      </UnstyledButton>
      <Collapse expanded={open}>
        <Text size="sm" c="dimmed" style={{ whiteSpace: "pre-wrap" }} mt={4}>
          {text}
        </Text>
      </Collapse>
    </div>
  );
}

export function PromptBubble({ text }: { text: string }) {
  return (
    <Group justify="flex-end">
      <Paper radius="md" px="md" py="sm" bg="var(--mantine-color-default-hover)" maw="min(600px, 85%)">
        <Text size="sm" c="dimmed" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
          {text}
        </Text>
      </Paper>
    </Group>
  );
}

function Item({ item }: { item: TimelineItem }) {
  switch (item.type) {
    case "message":
      return (
        <Text size="sm" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
          {item.text}
        </Text>
      );
    case "reasoning":
      return <Reasoning text={item.text} />;
    case "tool_call":
      return <ToolCallCard call={item.call} />;
    case "error":
      return (
        <Alert color="red" variant="light" icon={<IconAlertTriangle size={16} />} p="xs">
          <Text size="sm" style={{ whiteSpace: "pre-wrap" }}>
            {item.message}
          </Text>
        </Alert>
      );
  }
}

/**
 * One agent's answer to one prompt. `turn` is missing when the agent's session ended before this prompt.
 */
export function AgentColumn({ name, turn, first }: { name: string; turn?: Turn; first: boolean }) {
  const elapsed = useElapsed(turn);
  const badgeColor = turn ? STATUS_COLORS[turn.status] : "gray";
  return (
    <Paper withBorder radius="md" p="sm">
      <Group justify="space-between" mb="sm">
        <Group gap="xs">
          <Title order={4} ff="text" fz="lg" fw={600}>
            {name}
          </Title>
          {badgeColor && (
            <Badge color={badgeColor} variant="light" size="sm" radius="xl">
              {turn ? turn.status : "not sent"}
            </Badge>
          )}
        </Group>
        <Text size="sm" c="dimmed" ff="monospace">
          {turn?.status === "done" && "Done in "}
          {formatDuration(elapsed)}
        </Text>
      </Group>
      <Stack gap="xs">
        {turn?.items.map((item) => (
          <Item key={item.key} item={item} />
        ))}
        {turn?.files && <FilesPanel {...turn.files} />}
        {turn?.status === "running" && turn.items.length === 0 && (
          <Text size="sm" c="dimmed">
            {first ? "Starting container…" : "Waiting for the agent…"}
          </Text>
        )}
        {turn && isFinished(turn.status) && turn.items.length === 0 && (
          <Text size="sm" c="dimmed">
            No output.
          </Text>
        )}
        {!turn && (
          <Text size="sm" c="dimmed">
            This agent's session had already ended.
          </Text>
        )}
      </Stack>
    </Paper>
  );
}
