import { createTheme, virtualColor, type MantineColorsTuple } from "@mantine/core";

const ink: MantineColorsTuple = [
  "#f5f5f5",
  "#e7e7e7",
  "#cdcdcd",
  "#b2b2b2",
  "#9a9a9a",
  "#5e5e5e",
  "#080808",
  "#060606",
  "#040404",
  "#000000",
];

export const theme = createTheme({
  fontFamily: "'Geist Variable', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  fontFamilyMonospace: "ui-monospace, SFMono-Regular, Menlo, monospace",
  headings: { fontFamily: "'Space Grotesk Variable', sans-serif", fontWeight: "500" },
  colors: {
    ink,
    // A near-black accent vanishes on a dark background, so dark mode uses the same ramp inverted.
    inkInverted: [...ink].reverse() as unknown as MantineColorsTuple,
    accent: virtualColor({ name: "accent", light: "ink", dark: "inkInverted" }),
  },
  primaryColor: "accent",
  autoContrast: true,
  defaultRadius: "md",
});
