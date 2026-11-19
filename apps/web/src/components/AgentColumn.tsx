import { useEffect, useState } from "react";
import { Alert, Badge, Collapse, Group, Loader, Paper, Stack, Text, Title, UnstyledButton } from "@mantine/core";
import { IconAlertTriangle, IconBrain } from "@tabler/icons-react";
import type { AgentState, TimelineItem } from "../state";
import { isFinished } from "../state";
import { formatDuration } from "../format";
import { ToolCallCard } from "./ToolCallCard";

const STATUS_COLORS: Record<AgentState["status"], string> = {
  idle: "gray",
  running: "blue",
  done: "green",
  failed: "red",
  cancelled: "yellow",
};

function useElapsed(agent: AgentState): number | undefined {
  const [now, setNow] = useState(Date.now());
  const running = agent.status === "running";
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  if (agent.startedAt === undefined) return undefined;
  return (agent.endedAt ?? Math.max(now, agent.startedAt)) - agent.startedAt;
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

export function AgentColumn({ name, agent }: { name: string; agent: AgentState }) {
  const elapsed = useElapsed(agent);
  return (
    <Paper withBorder radius="md" p="sm">
      <Group justify="space-between" mb="sm">
        <Group gap="xs">
          <Title order={4}>{name}</Title>
          <Badge color={STATUS_COLORS[agent.status]} variant="light" leftSection={agent.status === "running" ? <Loader size={10} color="blue" /> : null}>
            {agent.status}
          </Badge>
        </Group>
        <Text size="sm" c="dimmed" ff="monospace">
          {formatDuration(elapsed)}
        </Text>
      </Group>
      <Stack gap="xs">
        {agent.items.map((item) => (
          <Item key={item.key} item={item} />
        ))}
        {agent.status === "running" && agent.items.length === 0 && (
          <Text size="sm" c="dimmed">
            Starting container…
          </Text>
        )}
        {isFinished(agent.status) && agent.items.length === 0 && (
          <Text size="sm" c="dimmed">
            No output.
          </Text>
        )}
      </Stack>
    </Paper>
  );
}
