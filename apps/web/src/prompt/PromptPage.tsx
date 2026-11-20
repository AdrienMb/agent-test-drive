import { Fragment, useRef, useState } from "react";
import {
  Alert,
  Button,
  Container,
  Flex,
  Group,
  Stack,
  Text,
  Title,
  Tooltip,
} from "@mantine/core";
import { IconLock } from "@tabler/icons-react";
import { useNavigate } from "react-router";
import { AGENTS } from "@atd/shared";
import { errorMessage } from "../lib/format";
import { PromptTextarea } from "../ui/PromptTextarea";
import { SelectButton } from "../ui/SelectButton";

const PLACEHOLDER =
  "Write a Python script that prints the first 20 Fibonacci numbers, then run it.";

const SUGGESTIONS = [
  {
    label: "Function to print Fibonacci numbers",
    prompt: PLACEHOLDER,
  },
  {
    label: "Write a function is_palindrome",
    prompt:
      "Write a Python function is_palindrome(s) that ignores case and punctuation, add a few tests, and run them.",
  },
  {
    label: "Fix a bug in this code",
    prompt: `Fix the bug in this code, then run it to show it works:

def average(nums):
    total = 0
    for i in range(1, len(nums)):
        total += nums[i]
    return total / len(nums)

print(average([1, 2, 3, 4]))  # should print 2.5`,
  },
];

export function PromptPage({ onLocked }: { onLocked: () => void }) {
  const navigate = useNavigate();
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string>();
  const [starting, setStarting] = useState(false);
  // `starting` only updates on the next render, too late to stop a quick second Enter.
  const startingRef = useRef(false);

  async function send(prompt: string) {
    if (!prompt || startingRef.current) return;
    startingRef.current = true;
    setStarting(true);
    setError(undefined);
    try {
      const res = await fetch("/api/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt }),
      });
      if (res.status === 401) return onLocked();
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      const { runId } = (await res.json()) as { runId: string };
      navigate(`/runs/${runId}`, { state: { prompt } });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      startingRef.current = false;
      setStarting(false);
    }
  }

  return (
    <Container size={840} pt={{ base: 48, sm: 120 }} pb="xl">
      <Stack gap="xl">
        <Stack gap={4}>
          <Title order={1}>Agent test drive</Title>
          <Text size="md" c="dimmed">
            Send a prompt to benchmark agents side by side
          </Text>
        </Stack>

        <Flex
          direction={{ base: "column", sm: "row" }}
          align={{ base: "stretch", sm: "center" }}
          gap="md"
        >
          {AGENTS.map((agent, i) => (
            <Fragment key={agent.id}>
              {i > 0 && (
                <Text c="dimmed" ta="center" px="lg">
                  VS
                </Text>
              )}
              <Tooltip label="More models coming soon">
                <SelectButton
                  flex={1}
                  size="md"
                  title={agent.label}
                  subtitle={`${agent.model} | ${agent.effort} effort`}
                  leftSection={<IconLock size={18} stroke={1.5} />}
                  disabled
                />
              </Tooltip>
            </Fragment>
          ))}
        </Flex>

        {error && (
          <Alert
            color="red"
            title="Could not start the run"
            withCloseButton
            onClose={() => setError(undefined)}
          >
            {error}
          </Alert>
        )}

        <PromptTextarea
          aria-label="Prompt"
          placeholder={PLACEHOLDER}
          value={draft}
          onChange={setDraft}
          onSubmit={() => void send(draft.trim())}
          loading={starting}
        />

        <Stack gap="sm">
          <Text c="dimmed">Or try these ones</Text>
          <Group gap="sm">
            {SUGGESTIONS.map((s) => (
              <Button
                key={s.label}
                variant="default"
                radius="xl"
                fw={400}
                c="dimmed"
                disabled={starting}
                onClick={() => send(s.prompt)}
              >
                {s.label}
              </Button>
            ))}
          </Group>
        </Stack>
      </Stack>
    </Container>
  );
}
