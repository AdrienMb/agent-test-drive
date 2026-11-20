import { useEffect, useReducer, useState } from "react";
import { Alert, AppShell, Button, Container, Group, Paper, SimpleGrid, Stack, Text, Title, UnstyledButton } from "@mantine/core";
import { IconPlayerStop, IconPlus } from "@tabler/icons-react";
import { Link, useLocation, useParams } from "react-router";
import { AGENTS, type RunEvent } from "@atd/shared";
import { initialState, isFinished, reducer } from "../state";
import { errorMessage } from "../format";
import { AgentColumn } from "../components/AgentColumn";
import { ComparisonTable } from "../components/ComparisonTable";

export function RunPage({ onLocked }: { onLocked: () => void }) {
  const { runId } = useParams() as { runId: string };
  // The server does not keep the prompt; it travels in history state, which survives a reload.
  const prompt = (useLocation().state as { prompt?: string } | null)?.prompt ?? "";
  return <Run key={runId} runId={runId} prompt={prompt} onLocked={onLocked} />;
}

function Run({ runId, prompt, onLocked }: { runId: string; prompt: string; onLocked: () => void }) {
  const [state, dispatch] = useReducer(reducer, undefined, () => reducer(initialState, { type: "start", runId, prompt }));
  const [cancelError, setCancelError] = useState<string>();

  const allFinished = AGENTS.every((a) => isFinished(state.agents[a.id].status));

  useEffect(() => {
    if (allFinished) return;
    const source = new EventSource(`/api/runs/${runId}/events`);
    source.onmessage = (msg) => dispatch({ type: "event", event: JSON.parse(msg.data) as RunEvent });
    // EventSource retries network errors by itself; CLOSED means it gave up (e.g. a 404 after a server restart).
    source.onerror = () => {
      if (source.readyState === EventSource.CLOSED) {
        dispatch({ type: "disconnected", message: "Lost the connection to this run. The server may have restarted." });
      }
    };
    return () => source.close();
  }, [runId, allFinished]);

  async function cancel() {
    try {
      const res = await fetch(`/api/runs/${runId}/cancel`, { method: "POST" });
      if (res.status === 401) {
        onLocked();
      } else if (res.status === 404) {
        dispatch({ type: "disconnected", message: "The server no longer knows this run, so it could not be cancelled." });
      } else if (!res.ok) {
        throw new Error(`${res.status} ${await res.text()}`);
      }
    } catch (err) {
      setCancelError(errorMessage(err));
    }
  }

  return (
    <AppShell header={{ height: 52 }} padding="md">
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between">
          <UnstyledButton component={Link} to="/">
            <Title order={4}>Agent test drive</Title>
          </UnstyledButton>
          {allFinished ? (
            <Button size="xs" variant="default" leftSection={<IconPlus size={14} />} component={Link} to="/">
              New prompt
            </Button>
          ) : (
            <Button size="xs" color="red" variant="light" leftSection={<IconPlayerStop size={14} />} onClick={cancel}>
              Cancel
            </Button>
          )}
        </Group>
      </AppShell.Header>

      <AppShell.Main>
        <Container size="xl">
          <Stack>
            {cancelError && (
              <Alert color="red" title="Could not cancel the run" withCloseButton onClose={() => setCancelError(undefined)}>
                {cancelError}
              </Alert>
            )}
            {state.prompt && (
              <Group justify="flex-end">
                <Paper radius="lg" px="md" py="xs" bg="var(--mantine-color-default-hover)" maw="80%">
                  <Text size="sm" style={{ whiteSpace: "pre-wrap" }}>
                    {state.prompt}
                  </Text>
                </Paper>
              </Group>
            )}
            <SimpleGrid cols={{ base: 1, md: 2 }} style={{ alignItems: "start" }}>
              {AGENTS.map((a) => (
                <AgentColumn key={a.id} name={a.label} agent={state.agents[a.id]} />
              ))}
            </SimpleGrid>
            {allFinished && <ComparisonTable agents={state.agents} />}
          </Stack>
        </Container>
      </AppShell.Main>
    </AppShell>
  );
}
