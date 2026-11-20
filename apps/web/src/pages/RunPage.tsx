import { useEffect, useReducer, useRef, useState } from "react";
import { Alert, Button, Container, Group, SimpleGrid, Stack, Text, Title, UnstyledButton } from "@mantine/core";
import { Link, useLocation, useParams } from "react-router";
import { AGENTS, type RunEvent } from "@atd/shared";
import { currentTurn, initialState, isFinished, reducer, type State } from "../state";
import { errorMessage } from "../format";
import { AgentColumn, PromptBubble } from "../components/AgentColumn";
import { ComparisonTable } from "../components/ComparisonTable";
import { ThinkingLine } from "../components/ThinkingLine";
import { PromptTextarea } from "../ui/PromptTextarea";

/** One status line for both agents' answers to prompt `i`. */
function turnStatus(state: State, i: number): { text: string; active: boolean } {
  const sent = AGENTS.flatMap((a) => {
    const turn = state.agents[a.id].turns[i];
    return turn ? [{ label: a.label, turn }] : [];
  });
  const busy = sent.filter((s) => !isFinished(s.turn.status));
  if (busy.length === 0) return { text: "Agent answers", active: false };
  if (busy.every((s) => s.turn.items.length === 0)) {
    return { text: i === 0 ? "Starting the containers" : "Sending the prompt to the agents", active: true };
  }
  if (busy.length < sent.length) return { text: `Waiting for ${busy.map((s) => s.label).join(" and ")}`, active: true };
  return { text: "The agents are working", active: true };
}

/** One line when both sessions ended for the same reason, otherwise one per ended agent. */
function sessionEndLines(state: State): string[] {
  const ended = AGENTS.flatMap((a) => {
    const reason = state.agents[a.id].closed;
    return reason === undefined ? [] : [{ label: a.label, reason }];
  });
  if (ended.length === AGENTS.length && ended.every((e) => e.reason === ended[0].reason)) {
    return [`Session ended: ${ended[0].reason}`];
  }
  return ended.map((e) => `${e.label} session ended: ${e.reason}`);
}

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

  const allFinished = AGENTS.every((a) => isFinished(currentTurn(state.agents[a.id]).status));
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
    <Container size="xl" py="lg">
      <Stack gap={40}>
        <Group justify="space-between">
          <UnstyledButton component={Link} to="/">
            <Title order={3}>Agent test drive</Title>
          </UnstyledButton>
          <Group gap="xs">
            {!sessionOver && (
              <Button size="sm" radius="xl" variant="default" fw={400} onClick={cancel}>
                {allFinished ? "End session" : "Cancel"}
              </Button>
            )}
            <Button size="sm" radius="xl" fw={400} component={Link} to="/">
              New prompt
            </Button>
          </Group>
        </Group>

        {error && (
          <Alert color="red" title={error.title} withCloseButton onClose={() => setError(undefined)}>
            {error.message}
          </Alert>
        )}

        {state.prompts.map((prompt, i) => (
          <Stack key={i} gap="xl">
            {prompt && <PromptBubble text={prompt} />}
            <Stack gap="xs">
              <ThinkingLine {...turnStatus(state, i)} />
              <SimpleGrid cols={{ base: 1, md: 2 }} style={{ alignItems: "start" }}>
                {AGENTS.map((a) => (
                  <AgentColumn key={a.id} name={a.label} turn={state.agents[a.id].turns[i]} first={i === 0} />
                ))}
              </SimpleGrid>
            </Stack>
          </Stack>
        ))}

        {allFinished && (
          <Stack gap="xs">
            <Text c="dimmed">Result analysis</Text>
            <ComparisonTable agents={state.agents} />
          </Stack>
        )}

        {sessionEndLines(state).map((line) => (
          <Text key={line} c="dimmed">
            {line}
          </Text>
        ))}

        {canFollowUp && (
          // Same container as the prompt page, so both boxes are the same width.
          <Container size={840} w="100%">
            <PromptTextarea
              aria-label="Follow-up prompt"
              placeholder="Ask a follow-up, e.g. “Add tests for this code”"
              value={draft}
              onChange={setDraft}
              onSubmit={() => void followUp()}
              sendLabel="Send follow-up"
              loading={sending}
            />
          </Container>
        )}
      </Stack>
    </Container>
  );
}
