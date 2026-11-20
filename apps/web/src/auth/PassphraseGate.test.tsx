import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { PassphraseGate } from "./PassphraseGate";

/** A fake server whose /api/session accepts only `correct`, read from the cookie like the real gate. */
function serve(correct: string | undefined) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      const cookie = document.cookie.match(/atd_passphrase=([^;]*)/)?.[1];
      const ok = correct === undefined || (cookie !== undefined && decodeURIComponent(cookie) === correct);
      return new Response(null, { status: ok ? 204 : 401 });
    }),
  );
}

function renderGate() {
  let lock = () => {};
  render(
    <MantineProvider>
      <PassphraseGate>
        {(l) => {
          lock = l;
          return <p>the app</p>;
        }}
      </PassphraseGate>
    </MantineProvider>,
  );
  return { lock: () => lock() };
}

const unlock = async (value: string) => {
  fireEvent.change(await screen.findByLabelText("Passphrase"), { target: { value } });
  fireEvent.click(screen.getByRole("button", { name: "Unlock" }));
};

afterEach(() => {
  document.cookie = "atd_passphrase=; Path=/; Max-Age=0";
  vi.unstubAllGlobals();
});

describe("PassphraseGate", () => {
  it("opens straight away when the server has no passphrase", async () => {
    serve(undefined);
    renderGate();
    expect(await screen.findByText("the app")).toBeDefined();
  });

  it("stores an accepted passphrase in the cookie and opens", async () => {
    serve("open sesame");
    renderGate();
    await unlock("open sesame");
    expect(await screen.findByText("the app")).toBeDefined();
    expect(document.cookie).toContain("atd_passphrase=open%20sesame");
  });

  it("refuses a wrong passphrase and does not keep it", async () => {
    serve("open sesame");
    renderGate();
    await unlock("nope");
    expect(await screen.findByText("Wrong passphrase.")).toBeDefined();
    expect(screen.queryByText("the app")).toBeNull();
    expect(document.cookie).not.toContain("atd_passphrase");
  });

  it("asks again after lock()", async () => {
    serve("open sesame");
    const { lock } = renderGate();
    await unlock("open sesame");
    await screen.findByText("the app");
    lock();
    expect(await screen.findByText(/no longer accepted/)).toBeDefined();
    expect(document.cookie).not.toContain("atd_passphrase");
  });
});
