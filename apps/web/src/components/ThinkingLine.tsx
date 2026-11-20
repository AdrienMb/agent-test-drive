import { useEffect, useState } from "react";
import { Group, Text } from "@mantine/core";
import { useReducedMotion } from "@mantine/hooks";
import classes from "./ThinkingLine.module.css";

const GLYPHS = ["·", "✢", "✳", "✶", "✻", "✽"];
const FRAMES = [...GLYPHS, ...GLYPHS.slice(1, -1).reverse()];

function useFrame(running: boolean): number {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setFrame((f) => (f + 1) % FRAMES.length), 120);
    return () => clearInterval(timer);
  }, [running]);
  return frame;
}

/** The line above the agent cards: a static label, or an animated status while the agents work. */
export function ThinkingLine({ text, active }: { text: string; active: boolean }) {
  const reduceMotion = useReducedMotion();
  const frame = useFrame(active && !reduceMotion);
  return (
    <Group gap={8} wrap="nowrap" aria-live="polite">
      {active && (
        <span className={classes.glyph} aria-hidden>
          {reduceMotion ? "✻" : FRAMES[frame]}
        </span>
      )}
      <Text c="dimmed" className={active ? classes.shimmer : undefined}>
        {active ? `${text}…` : text}
      </Text>
    </Group>
  );
}
