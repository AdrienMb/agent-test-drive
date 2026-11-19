import { useState } from "react";
import { ActionIcon, Badge, Code, Group, Paper, Stack, Text, UnstyledButton } from "@mantine/core";
import { IconChevronDown, IconChevronRight, IconDownload, IconFile, IconFolder } from "@tabler/icons-react";
import type { FileSkipReason, WorkspaceFile } from "@atd/shared";
import { countWorkspaceFiles, type FilesEvent } from "../state";
import { formatBytes } from "../format";
import { downloadText } from "../download";

const SKIP_LABELS: Record<FileSkipReason, { label: string; hint: string }> = {
  binary: { label: "binary", hint: "Binary files are not shown" },
  too_large: { label: "too large", hint: "Too large to show" },
  budget: { label: "not loaded", hint: "Left out to keep the run small" },
  sensitive: { label: "hidden", hint: "May contain secrets, so its content is never sent" },
  dir: { label: "skipped folder", hint: "Dependency or cache folder, not scanned" },
};

function FileRow({ file }: { file: WorkspaceFile }) {
  const [open, setOpen] = useState(false);
  const hasContent = file.content !== undefined;
  const skip = file.skipped && SKIP_LABELS[file.skipped];
  const Icon = file.skipped === "dir" ? IconFolder : IconFile;

  return (
    <div>
      <Group gap="xs" wrap="nowrap">
        <UnstyledButton
          onClick={() => setOpen((o) => !o)}
          disabled={!hasContent}
          aria-expanded={hasContent ? open : undefined}
          style={{ flex: 1, minWidth: 0, cursor: hasContent ? "pointer" : "default" }}
        >
          <Group gap="xs" wrap="nowrap">
            {hasContent ? open ? <IconChevronDown size={14} /> : <IconChevronRight size={14} /> : <Icon size={14} />}
            <Text size="sm" ff="monospace" truncate="end" style={{ flex: 1, minWidth: 0 }} title={file.path}>
              {file.path}
            </Text>
          </Group>
        </UnstyledButton>
        {skip && (
          <Badge size="xs" variant="light" color="gray" tt="none" title={skip.hint}>
            {skip.label}
          </Badge>
        )}
        {file.skipped !== "dir" && (
          <Text size="xs" c="dimmed" ff="monospace">
            {formatBytes(file.size)}
          </Text>
        )}
        {hasContent && (
          <ActionIcon size="sm" variant="subtle" aria-label={`Download ${file.path}`} onClick={() => downloadText(file.path, file.content!)}>
            <IconDownload size={14} />
          </ActionIcon>
        )}
      </Group>
      {/* Always plain text: agent-written HTML, SVG or Markdown is never rendered. */}
      {open && hasContent && (
        <Code block mt={4} style={{ maxHeight: 320, overflow: "auto", fontSize: 12 }}>
          {file.content}
        </Code>
      )}
    </div>
  );
}

export function FilesPanel({ files, truncated }: Pick<FilesEvent, "files" | "truncated">) {
  const count = countWorkspaceFiles(files);
  return (
    <Paper withBorder radius="sm" p="xs">
      <Group gap="xs" mb={files.length ? 6 : 0}>
        <IconFolder size={16} />
        <Text size="sm" fw={500}>
          Workspace files ({count})
        </Text>
      </Group>
      <Stack gap={4}>
        {files.map((file) => (
          <FileRow key={file.path} file={file} />
        ))}
      </Stack>
      {files.length === 0 && (
        <Text size="xs" c="dimmed">
          The agent left no files.
        </Text>
      )}
      {truncated && (
        <Text size="xs" c="dimmed" mt={4}>
          Some files were left out (too many, or unsafe names).
        </Text>
      )}
    </Paper>
  );
}
