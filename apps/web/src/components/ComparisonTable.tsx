import { Paper, Table, Title } from "@mantine/core";
import { AGENTS, type AgentId, type ToolKind } from "@atd/shared";
import { countWorkspaceFiles, type AgentState } from "../state";
import { formatCost, formatDuration, formatNumber } from "../format";
import { TOOL_KINDS } from "../toolKinds";

function stats(agent: AgentState) {
  const calls = agent.items.flatMap((i) => (i.type === "tool_call" ? [i.call] : []));
  const byKind = new Map<ToolKind, number>();
  for (const c of calls) byKind.set(c.tool, (byKind.get(c.tool) ?? 0) + 1);
  const files = new Set(calls.flatMap((c) => (c.tool === "file_edit" ? (c.files ?? []) : [])));
  const wall = agent.startedAt !== undefined ? agent.wallMs : undefined;
  const created = agent.files && countWorkspaceFiles(agent.files.files);
  return { calls: calls.length, byKind, files: [...files], created, wall, usage: agent.usage };
}

export function ComparisonTable({ agents }: { agents: Record<AgentId, AgentState> }) {
  const s = Object.fromEntries(AGENTS.map((a) => [a.id, stats(agents[a.id])])) as Record<AgentId, ReturnType<typeof stats>>;
  const kinds = (Object.keys(TOOL_KINDS) as ToolKind[]).filter((k) => AGENTS.some((a) => s[a.id].byKind.has(k)));

  const rows: [string, (x: ReturnType<typeof stats>) => string][] = [
    ["Wall time (incl. container start)", (x) => formatDuration(x.wall)],
    ["Agent time", (x) => formatDuration(x.usage?.durationMs)],
    ["Tool calls", (x) => String(x.calls)],
    ...kinds.map((k): [string, (x: ReturnType<typeof stats>) => string] => [`  ${TOOL_KINDS[k].label}`, (x) => String(x.byKind.get(k) ?? 0)]),
    ["Files edited", (x) => (x.files.length ? `${x.files.length} (${x.files.join(", ")})` : "0")],
    ["Files in workspace", (x) => (x.created === undefined ? "—" : String(x.created))],
    ["Input tokens", (x) => formatNumber(x.usage?.inputTokens)],
    ["Output tokens", (x) => formatNumber(x.usage?.outputTokens)],
    ["Cost", (x) => formatCost(x.usage?.costUsd)],
  ];

  return (
    <Paper withBorder radius="md" p="sm">
      <Title order={5} mb="xs">
        Comparison
      </Title>
      <Table striped withColumnBorders>
        <Table.Thead>
          <Table.Tr>
            <Table.Th />
            {AGENTS.map((a) => (
              <Table.Th key={a.id}>{a.label}</Table.Th>
            ))}
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {rows.map(([label, value]) => (
            <Table.Tr key={label}>
              <Table.Td style={{ whiteSpace: "pre" }}>{label}</Table.Td>
              {AGENTS.map((a) => (
                <Table.Td key={a.id}>{value(s[a.id])}</Table.Td>
              ))}
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Paper>
  );
}
