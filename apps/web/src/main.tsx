import "@mantine/core/styles.css";
import "@fontsource-variable/geist";
import "@fontsource-variable/space-grotesk";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MantineProvider } from "@mantine/core";
import { BrowserRouter } from "react-router";
import { App } from "./App";
import { PassphraseGate } from "./components/PassphraseGate";
import { theme } from "./theme";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <MantineProvider theme={theme} defaultColorScheme="auto">
      <BrowserRouter>
        <PassphraseGate>{(lock) => <App onLocked={lock} />}</PassphraseGate>
      </BrowserRouter>
    </MantineProvider>
  </StrictMode>,
);
