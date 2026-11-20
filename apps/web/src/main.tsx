import "@mantine/core/styles.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MantineProvider } from "@mantine/core";
import { App } from "./App";
import { PassphraseGate } from "./components/PassphraseGate";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <MantineProvider defaultColorScheme="auto">
      <PassphraseGate>{(lock) => <App onLocked={lock} />}</PassphraseGate>
    </MantineProvider>
  </StrictMode>,
);
