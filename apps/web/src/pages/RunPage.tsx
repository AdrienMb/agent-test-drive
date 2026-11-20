import { useEffect, useReducer, useRef, useState } from "react";
import { ActionIcon, Alert, AppShell, Button, Container, Group, SimpleGrid, Stack, Textarea, Title, UnstyledButton } from "@mantine/core";
import { IconArrowUp, IconPlayerStop, IconPlus } from "@tabler/icons-react";
import { Link, useLocation, useParams } from "react-router";
import { AGENTS, type RunEvent } from "@atd/shared";
import { initialState, isFinished, reducer } from "../state";
import { errorMessage } from "../format";
import { AgentColumn, PromptBubble } from "../components/AgentColumn";
import { ComparisonTable } from "../components/ComparisonTable";

export function RunPage({ onLocked }: { onLocked: () => void }) {
  const { runId } = useParams() as { runId: string };
  // The server does not keep the prompt; it travels in history state, which survives a reload.
  const prompt = (useLocation().state as { prompt?: string } | null)?.prompt ?? "";
  return <Run key={runId} runId={runId} prompt={prompt} onLocked={onLocked} />;
}

function Run({ runId, prompt, onLocked }: { runId: string; prompt: string; onLocked: () => void }) {
  const [state, dispatch] = useReducer(reducer, undefined, () => reducer(initialState, { type: "start", runId, prompt }));
  const [error, setError] = useState<{ title: string; message: string }>();
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  // `sending` only updates on the next render, too late to stop a quick second Enter.
  const sendingRef = useRef(false);

  const allFinished = AGENTS.every((a) => isFinished(state.agents[a.id].status));
  const sessionOver = AGENTS.every((a) => state.agents[a.id].closed !== undefined);
  const canFollowUp = allFinished && !sessionOver;

  useEffect(() => {
    if (sessionOver) return;
    const source = new EventSource(`/api/runs/${runId}/events`);
    source.onmessage = (msg) => dispatch({ type: "event", event: JSON.parse(msg.data) as RunEvent });
    // EventSource retries network errors by itself; CLOSED means it gave up (e.g. a 404 after a server restart).
    source.onerror = () => {
      if (source.readyState === EventSource.CLOSED) {
        dispatch({ type: "disconnected", message: "Lost the connection to this run. The server may have restarted." });
      }
    };
    return () => source.close();
  }, [runId, sessionOver]);

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
      setError({ title: "Could not stop the run", message: errorMessage(err) });
    }
  }

  async function followUp() {
    const prompt = draft.trim();
    if (!prompt || sendingRef.current) return;
    sendingRef.current = true;
    setSending(true);
    setError(undefined);
    try {
      const res = await fetch(`/api/runs/${runId}/prompts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt }),
      });
      if (res.status === 401) return onLocked();
      if (res.status === 404) {
        dispatch({ type: "disconnected", message: "The server no longer knows this run." });
        return;
      }
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      setDraft("");
    } catch (err) {
      setError({ title: "Could not send the follow-up", message: errorMessage(err) });
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }

  return (
    <AppShell header={{ height: 52 }} padding="md">
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between">
          <UnstyledButton component={Link} to="/">
            <Title order={4}>Agent test drive</Title>
          </UnstyledButton>
          {sessionOver ? (
            <Button size="xs" variant="default" leftSection={<IconPlus size={14} />} component={Link} to="/">
              New prompt
            </Button>
          ) : allFinished ? (
            <Button size="xs" variant="default" leftSection={<IconPlayerStop size={14} />} onClick={cancel}>
              End session
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
            {error && (
              <Alert color="red" title={error.title} withCloseButton onClose={() => setError(undefined)}>
                {error.message}
              </Alert>
            )}
            {state.prompt && <PromptBubble text={state.prompt} />}
            <SimpleGrid cols={{ base: 1, md: 2 }} style={{ alignItems: "start" }}>
              {AGENTS.map((a) => (
                <AgentColumn key={a.id} name={a.label} agent={state.agents[a.id]} />
              ))}
            </SimpleGrid>
            {allFinished && <ComparisonTable agents={state.agents} />}
            {canFollowUp && (
              <Textarea
                aria-label="Follow-up prompt"
                placeholder="Ask a follow-up, e.g. “Add tests for this code”"
                autosize
                minRows={2}
                maxRows={10}
                value={draft}
                onChange={(e) => setDraft(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    void followUp();
                  }
                }}
                rightSectionWidth={52}
                rightSectionProps={{ style: { alignItems: "flex-end", paddingBottom: 8 } }}
                rightSection={
                  <ActionIcon size="lg" aria-label="Send follow-up" onClick={followUp} loading={sending} disabled={!draft.trim()}>
                    <IconArrowUp size={18} />
                  </ActionIcon>
                }
              />
            )}
          </Stack>
        </Container>
      </AppShell.Main>
    </AppShell>
  );
}
