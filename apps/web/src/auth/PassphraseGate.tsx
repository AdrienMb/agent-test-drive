import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import {
  Alert,
  Button,
  Center,
  Loader,
  Paper,
  PasswordInput,
  Stack,
  Title,
} from "@mantine/core";
import { IconLock } from "@tabler/icons-react";
import {
  checkPassphrase,
  forgetPassphrase,
  savePassphrase,
} from "./passphrase";
import { errorMessage } from "../lib/format";

type Status = "checking" | "locked" | "open";

/** Shows the passphrase form until the server accepts the passphrase; `lock` brings the form back. */
export function PassphraseGate({
  children,
}: {
  children: (lock: () => void) => ReactNode;
}) {
  const [status, setStatus] = useState<Status>("checking");
  const [value, setValue] = useState("");
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    checkPassphrase()
      .then((ok) => setStatus(ok ? "open" : "locked"))
      .catch((err: unknown) => {
        setError(`Could not reach the server: ${errorMessage(err)}`);
        setStatus("locked");
      });
  }, []);

  function lock() {
    forgetPassphrase();
    setError("The passphrase is no longer accepted. Enter it again.");
    setStatus("locked");
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!value || submitting) return;
    setSubmitting(true);
    setError(undefined);
    savePassphrase(value);
    try {
      if (await checkPassphrase()) {
        setValue("");
        setStatus("open");
      } else {
        forgetPassphrase();
        setError("Wrong passphrase.");
      }
    } catch (err) {
      setError(`Could not reach the server: ${errorMessage(err)}`);
    } finally {
      setSubmitting(false);
    }
  }

  if (status === "open") return children(lock);
  if (status === "checking") {
    return (
      <Center h="100vh">
        <Loader />
      </Center>
    );
  }
  return (
    <Center h="100vh" px="md">
      <Paper component="form" onSubmit={submit} w="100%" maw={360}>
        <Stack>
          <Title order={4}>Agent Test Drive</Title>
          {error && <Alert color="red">{error}</Alert>}
          <PasswordInput
            label="Passphrase"
            autoFocus
            autoComplete="current-password"
            value={value}
            onChange={(e) => setValue(e.currentTarget.value)}
          />
          <Button
            type="submit"
            leftSection={<IconLock size={16} />}
            loading={submitting}
            disabled={!value}
          >
            Unlock
          </Button>
        </Stack>
      </Paper>
    </Center>
  );
}
