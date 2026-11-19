import type { ToolKind } from "@atd/shared";
import {
  IconEye,
  IconFileCode,
  IconListCheck,
  IconPlug,
  IconTerminal2,
  IconTool,
  IconWorld,
  type Icon,
} from "@tabler/icons-react";

export const TOOL_KINDS: Record<ToolKind, { label: string; color: string; icon: Icon }> = {
  shell: { label: "Shell", color: "blue", icon: IconTerminal2 },
  file_edit: { label: "File edit", color: "orange", icon: IconFileCode },
  web_search: { label: "Web", color: "teal", icon: IconWorld },
  mcp: { label: "MCP", color: "indigo", icon: IconPlug },
  todo: { label: "Todo", color: "yellow", icon: IconListCheck },
  read: { label: "Read", color: "gray", icon: IconEye },
  other: { label: "Other", color: "gray", icon: IconTool },
};
