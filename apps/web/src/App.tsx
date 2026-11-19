import { useEffect, useReducer, useRef, useState } from "react";
import { Alert, AppShell, Button, Container, Group, Paper, SimpleGrid, Stack, Text, Textarea, Title } from "@mantine/core";
import { IconPlayerStop, IconSend } from "@tabler/icons-react";
import { AGENTS, type RunEvent } from "@atd/shared";
import { initialState, isFinished, reducer } from "./state";
import { AgentColumn } from "./components/AgentColumn";
import { ComparisonTable } from "./components/ComparisonTable";

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

const EXAMPLE = "Write a Python script that prints the first 20 Fibonacci numbers, then run it";

export function App() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const [draft, setDraft] = useState(EXAMPLE);
  const [requestError, setRequestError] = useState<{ title: string; message: string }>();
  const [starting, setStarting] = useState(false);
  // The state above only updates on the next render, too late to stop a quick second Cmd+Enter.
  const startingRef = useRef(false);

  const allFinished = AGENTS.every((a) => isFinished(state.agents[a.id].status));
  const inProgress = state.runId !== undefined && !allFinished;

  useEffect(() => {
    if (!state.runId || allFinished) return;
    const source = new EventSource(`/api/runs/${state.runId}/events`);
    source.onmessage = (msg) => dispatch({ type: "event", event: JSON.parse(msg.data) as RunEvent });
    // EventSource retries network errors by itself; CLOSED means it gave up (e.g. a 404 after a server restart).
    source.onerror = () => {
      if (source.readyState === EventSource.CLOSED) {
        dispatch({ type: "disconnected", message: "Lost the connection to this run. The server may have restarted." });
      }
    };
    return () => source.close();
  }, [state.runId, allFinished]);

  async function send() {
    const prompt = draft.trim();
    if (!prompt || inProgress || startingRef.current) return;
    startingRef.current = true;
    setStarting(true);
    setRequestError(undefined);
    try {
      const res = await fetch("/api/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt }),
      });
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      const { runId } = (await res.json()) as { runId: string };
      dispatch({ type: "start", runId, prompt });
    } catch (err) {
      setRequestError({ title: "Could not start the run", message: errorMessage(err) });
    } finally {
      startingRef.current = false;
      setStarting(false);
    }
  }

  async function cancel() {
    if (!state.runId) return;
    try {
      const res = await fetch(`/api/runs/${state.runId}/cancel`, { method: "POST" });
      if (res.status === 404) {
        dispatch({ type: "disconnected", message: "The server no longer knows this run, so it could not be cancelled." });
      } else if (!res.ok) {
        throw new Error(`${res.status} ${await res.text()}`);
      }
    } catch (err) {
      setRequestError({ title: "Could not cancel the run", message: errorMessage(err) });
    }
  }

  return (
    <AppShell header={{ height: 52 }} footer={{ height: 112 }} padding="md">
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between">
          <Title order={4}>Agent Test Drive</Title>
          {inProgress && (
            <Button size="xs" color="red" variant="light" leftSection={<IconPlayerStop size={14} />} onClick={cancel}>
              Cancel
            </Button>
          )}
        </Group>
      </AppShell.Header>

      <AppShell.Main>
        <Container size="xl">
          <Stack>
            {requestError && (
              <Alert color="red" title={requestError.title} withCloseButton onClose={() => setRequestError(undefined)}>
                {requestError.message}
              </Alert>
            )}
            {!state.prompt && (
              <Text c="dimmed" ta="center" mt="xl">
                Send a prompt to run Claude Code and Codex side by side, each in its own container.
              </Text>
            )}
            {state.prompt && (
              <Group justify="flex-end">
                <Paper radius="lg" px="md" py="xs" bg="var(--mantine-primary-color-light)" maw="80%">
                  <Text size="sm" style={{ whiteSpace: "pre-wrap" }}>
                    {state.prompt}
                  </Text>
                </Paper>
              </Group>
            )}
            {state.runId && (
              <SimpleGrid cols={{ base: 1, md: 2 }} style={{ alignItems: "start" }}>
                {AGENTS.map((a) => (
                  <AgentColumn key={a.id} name={a.label} agent={state.agents[a.id]} />
                ))}
              </SimpleGrid>
            )}
            {state.runId && allFinished && <ComparisonTable agents={state.agents} />}
          </Stack>
        </Container>
      </AppShell.Main>

      <AppShell.Footer p="sm">
        <Container size="xl">
          <Group align="flex-end" wrap="nowrap">
            <Textarea
              style={{ flex: 1 }}
              autosize
              minRows={2}
              maxRows={3}
              placeholder="Ask both agents something…"
              value={draft}
              onChange={(e) => setDraft(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void send();
              }}
            />
            <Button leftSection={<IconSend size={16} />} onClick={send} disabled={inProgress || starting || !draft.trim()}>
              Send
            </Button>
          </Group>
          <Text size="xs" c="dimmed" mt={4}>
            ⌘/Ctrl + Enter to send
          </Text>
        </Container>
      </AppShell.Footer>
    </AppShell>
  );
}
